#!/usr/bin/env python3
"""
MeshDash — a local web dashboard for a USB-connected MeshCore companion node.

Backend: Flask (sync) + a background asyncio thread that owns ONE persistent
MeshCore serial connection. All device commands are serialised behind a lock so
the request/response protocol never interleaves. The browser polls /api/status
and /api/events for a live view.
"""
import asyncio
import os
import threading
import time
import json
import hashlib
from collections import deque
from functools import wraps

from flask import Flask, jsonify, request, render_template

from meshcore.serial_cx import SerialConnection
from meshcore.meshcore import MeshCore
from meshcore.events import EventType

PORT = "/dev/ttyACM0"
BAUD = 115200
HTTP_PORT = int(os.environ.get("MESHDASH_PORT", "8787"))
DEMO = os.environ.get("MESHDASH_DEMO") == "1"   # serve synthetic data, no radio needed

app = Flask(__name__)

# ----------------------------------------------------------------------------
# Background asyncio loop (owns the radio connection)
# ----------------------------------------------------------------------------
loop = asyncio.new_event_loop()


def _run_loop():
    asyncio.set_event_loop(loop)
    loop.run_forever()


threading.Thread(target=_run_loop, daemon=True).start()

mc = None
cmd_lock = asyncio.Lock()
state = {"connected": False, "port": PORT, "error": None, "since_boot": time.time()}

events = deque(maxlen=800)
_event_id = 0
batt_history = deque(maxlen=240)     # (ts, millivolts)
event_counts = {}                    # type -> count
messages = {}                        # thread key -> deque of msg dicts
channels = {}                        # channel idx -> name
signal_history = deque(maxlen=150)   # {ts, rssi, snr} captured from RX events
pending_acks = {}                    # expected_ack hex -> outgoing message dict


def _add_msg(thread, direction, text, who, ts=None, status=None, ack=None):
    m = {"ts": ts or time.time(), "dir": direction, "text": text, "who": who}
    if status:
        m["status"] = status
    if ack:
        m["ack"] = ack
    messages.setdefault(thread, deque(maxlen=300)).append(m)
    return m


def _jsonable(x):
    try:
        json.dumps(x)
        return x
    except (TypeError, ValueError):
        if isinstance(x, dict):
            return {str(k): _jsonable(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [_jsonable(v) for v in x]
        if isinstance(x, (bytes, bytearray)):
            return x.hex()
        return str(x)


def _on_event(ev):
    global _event_id
    try:
        etype = ev.type.name if hasattr(ev.type, "name") else str(ev.type)
    except Exception:
        etype = "?"
    _event_id += 1
    event_counts[etype] = event_counts.get(etype, 0) + 1
    payload = _jsonable(getattr(ev, "payload", None))
    events.append({
        "id": _event_id,
        "ts": time.time(),
        "type": etype,
        "data": payload,
    })
    if isinstance(payload, dict):
        if ("rssi" in payload) or ("snr" in payload):
            signal_history.append({"ts": time.time(),
                                   "rssi": payload.get("rssi"),
                                   "snr": payload.get("snr")})
        if etype == "ACK":
            m = pending_acks.pop(payload.get("code"), None)
            if m:
                m["status"] = "delivered"
        if etype == "CHANNEL_MSG_RECV":
            idx = payload.get("channel_idx", 0)
            _add_msg(f"chan:{idx}", "in", payload.get("text", ""), f"ch{idx}",
                     payload.get("sender_timestamp"))
        elif etype == "CONTACT_MSG_RECV":
            pre = payload.get("pubkey_prefix", "?")
            _add_msg(f"dm:{pre}", "in", payload.get("text", ""), pre,
                     payload.get("sender_timestamp"))
    if etype == "DISCONNECTED":
        state["connected"] = False
    elif etype == "CONNECTED":
        state["connected"] = True


async def _connect():
    global mc
    conn = SerialConnection(PORT, BAUD)
    m = MeshCore(conn)
    await m.dispatcher.start()
    await m.connection_manager.connect()
    await asyncio.sleep(1.0)
    # USB-CDC companion firmware only talks once DTR is asserted ("terminal present")
    try:
        t = conn.transport
        if t and getattr(t, "serial", None):
            t.serial.rts = False
            t.serial.dtr = True
    except Exception:
        pass
    await asyncio.sleep(0.4)

    res = None
    for _ in range(6):
        try:
            res = await asyncio.wait_for(m.commands.send_appstart(), timeout=4)
        except asyncio.TimeoutError:
            res = None
        if res and res.type != EventType.ERROR:
            break
        await asyncio.sleep(1.0)
    if not res or res.type == EventType.ERROR:
        try:
            await m.disconnect()
        except Exception:
            pass
        raise RuntimeError("no appstart response from node")

    m.subscribe(None, _on_event)          # None == every event type
    await m.start_auto_message_fetching()  # surface incoming messages as events
    # discover channel slots 0..3
    channels.clear()
    for i in range(4):
        try:
            ev = await asyncio.wait_for(m.commands.get_channel(i), timeout=4)
            p = getattr(ev, "payload", {}) or {}
            channels[i] = p.get("channel_name", "") or ""
        except Exception:
            break
    mc = m
    state["connected"] = True
    state["error"] = None


async def _watchdog():
    while True:
        if mc is None or not state["connected"]:
            try:
                await _connect()
            except Exception as e:
                state["connected"] = False
                state["error"] = str(e)
                await asyncio.sleep(3)
                continue
        # periodic battery sample for the history chart
        try:
            async with cmd_lock:
                ev = await asyncio.wait_for(mc.commands.get_bat(), timeout=5)
            p = getattr(ev, "payload", {}) or {}
            mv = p.get("level")
            if mv:
                batt_history.append((time.time(), mv))
        except Exception as e:
            state["error"] = str(e)
        await asyncio.sleep(12)


def run(coro, timeout=12):
    """Run a device coroutine on the radio loop, serialised behind cmd_lock."""
    async def _locked():
        async with cmd_lock:
            return await coro
    return asyncio.run_coroutine_threadsafe(_locked(), loop).result(timeout)


# ----------------------------------------------------------------------------
# Demo mode (synthetic data — for screenshots / previews without hardware)
# ----------------------------------------------------------------------------
MOCK_SELF_INFO = {
    "adv_type": 1, "tx_power": 22, "max_tx_power": 22,
    "public_key": "9f3a7c2e8b14d05a6f29c7be11038d44a2c6e5f0d8917b3c4e6a2f1099aa55bb",
    "adv_lat": 59.32933, "adv_lon": 18.06858,
    "radio_freq": 869.618, "radio_bw": 62.5, "radio_sf": 8, "radio_cr": 8,
    "name": "MeshDash-Demo",
}
_DEMO_NODES = [
    ("1a2b3c4d5e6f70819203a4b5c6d7e8f90112233445566778899aabbccddeeff0", "DEMO-Relay-01", 59.331, 18.071),
    ("2b3c4d5e6f7081920a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677a", "DEMO-Node-Ada", 59.327, 18.064),
    ("3c4d5e6f708192030b1c2d3e4f5061728394a5b6c7d8e9f0112233445566778b", "DEMO-Gateway-7F", 59.335, 18.079),
    ("4d5e6f70819203040c1d2e3f405162738495a6b7c8d9e0f1223344556677889c", "DEMO-Beacon-X2", 59.322, 18.058),
    ("5e6f7081920304050d1e2f30415263748596a7b8c9d0e1f2334455667788990d", "DEMO-Repeater-9", 59.340, 18.090),
]
MOCK_CONTACTS = {
    k: {"public_key": k, "adv_name": n, "adv_lat": la, "adv_lon": lo,
        "type": 2, "out_path_len": -1, "flags": 0}
    for (k, n, la, lo) in _DEMO_NODES
}


def seed_demo():
    now = int(time.time())
    state["connected"] = True
    state["since_boot"] = now - 9240          # ~2h34m uptime
    curve = [4280, 4276, 4271, 4264, 4257, 4251, 4248, 4253, 4260, 4266,
             4271, 4276, 4280, 4282, 4279, 4275, 4270, 4266, 4272, 4278]
    for i in range(40):
        batt_history.append((now - (40 - i) * 30, curve[i % len(curve)]))
    channels.update({0: "Public", 1: "demo-priv", 2: "", 3: ""})
    for d, who, txt in [
        ("in", "DEMO-Relay-01", "anyone copy on the north link?"),
        ("out", "me", "loud and clear \U0001f44b"),
        ("in", "DEMO-Node-Ada", "coffee at the hackerspace 17:00?"),
        ("in", "DEMO-Gateway-7F", "gateway back online, bridging to mqtt"),
        ("out", "me", "nice — seeing you on the map now"),
    ]:
        _add_msg("chan:0", d, txt, who, now)
    # a demo PM thread (shows in the sidebar with an unread badge)
    _add_msg("dm:1a2b3c4d5e6f", "in", "ping — you around?", "DEMO-Relay-01", now - 240)
    _add_msg("dm:1a2b3c4d5e6f", "out", "yep, on the bench", "me", now - 180, status="delivered")
    _add_msg("dm:1a2b3c4d5e6f", "in", "can you bump TX to 22?", "DEMO-Relay-01", now - 60)
    _add_msg("dm:1a2b3c4d5e6f", "out", "on it \U0001f44d", "me", now - 30, status="sent")
    # signal history (rssi/snr curve)
    rs = [-68, -70, -73, -71, -69, -66, -72, -78, -83, -80, -75, -71, -67, -70, -74, -79, -76, -72, -69, -71]
    sn = [9, 8, 7, 8, 9, 10, 7, 5, 4, 5, 6, 8, 9, 8, 6, 5, 6, 7, 9, 8]
    for i in range(40):
        signal_history.append({"ts": now - (40 - i) * 20, "rssi": rs[i % len(rs)], "snr": sn[i % len(sn)]})
    samples = [
        ("ADVERTISEMENT", {"public_key": _DEMO_NODES[0][0]}),
        ("NEW_CONTACT", {"adv_name": "DEMO-Beacon-X2"}),
        ("RX_LOG_DATA", {"snr": 9, "rssi": -71, "payload_len": 24}),
        ("CHANNEL_MSG_RECV", {"channel_idx": 0, "text": "coffee at the hackerspace 17:00?"}),
        ("PATH_UPDATE", {"public_key": _DEMO_NODES[2][0]}),
        ("ACK", {"code": "3f9a1c22"}),
        ("ADVERTISEMENT", {"public_key": _DEMO_NODES[3][0]}),
        ("RX_LOG_DATA", {"snr": 7, "rssi": -83, "payload_len": 41}),
        ("CONTACT_MSG_RECV", {"pubkey_prefix": "1a2b3c4d5e6f", "text": "loud and clear"}),
        ("ADVERTISEMENT", {"public_key": _DEMO_NODES[4][0]}),
    ]
    global _event_id
    for i in range(60):
        et, data = samples[i % len(samples)]
        _event_id += 1
        event_counts[et] = event_counts.get(et, 0) + 1
        events.append({"id": _event_id, "ts": now - (60 - i) * 4, "type": et, "data": data})


# kick off connection + watchdog (or seed synthetic data in demo mode)
if DEMO:
    seed_demo()
else:
    asyncio.run_coroutine_threadsafe(_watchdog(), loop)


def require_node(f):
    @wraps(f)
    def wrapper(*a, **kw):
        if DEMO:
            # GETs fall through to mocked data; commands are accepted no-ops
            if request.method != "GET":
                return jsonify(ok=True, demo=True)
        elif mc is None:
            return jsonify(ok=False, error="node not connected"), 503
        try:
            return f(*a, **kw)
        except Exception as e:
            return jsonify(ok=False, error=str(e)), 500
    return wrapper


# ----------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    info = MOCK_SELF_INFO if DEMO else (_jsonable(getattr(mc, "self_info", {}) or {}) if mc else {})
    return jsonify({
        "connected": state["connected"],
        "demo": DEMO,
        "port": state["port"],
        "error": state["error"],
        "uptime": time.time() - state["since_boot"],
        "self_info": info,
        "battery_mv": batt_history[-1][1] if batt_history else None,
        "battery_history": [{"ts": t, "mv": v} for t, v in batt_history],
        "event_counts": event_counts,
        "event_total": _event_id,
        "signal_history": list(signal_history),
    })


@app.route("/api/events")
def api_events():
    since = int(request.args.get("since", 0))
    out = [e for e in events if e["id"] > since]
    return jsonify({"events": out, "last": (events[-1]["id"] if events else 0)})


@app.route("/api/contacts")
@require_node
def api_contacts():
    if DEMO:
        return jsonify(MOCK_CONTACTS)
    ev = run(mc.commands.get_contacts())
    return jsonify(_jsonable(getattr(ev, "payload", {}) or {}))


@app.route("/api/advert", methods=["POST"])
@require_node
def api_advert():
    flood = bool((request.json or {}).get("flood", False))
    run(mc.commands.send_advert(flood=flood))
    return jsonify(ok=True, flood=flood)


@app.route("/api/name", methods=["POST"])
@require_node
def api_name():
    name = (request.json or {}).get("name", "").strip()
    if not name:
        return jsonify(ok=False, error="empty name"), 400
    run(mc.commands.set_name(name))
    run(mc.commands.send_appstart())
    return jsonify(ok=True, name=name)


@app.route("/api/radio", methods=["POST"])
@require_node
def api_radio():
    d = request.json or {}
    run(mc.commands.set_radio(float(d["freq"]), float(d["bw"]), int(d["sf"]), int(d["cr"])))
    run(mc.commands.send_appstart())
    return jsonify(ok=True)


@app.route("/api/txpower", methods=["POST"])
@require_node
def api_txpower():
    run(mc.commands.set_tx_power(int((request.json or {})["dbm"])))
    run(mc.commands.send_appstart())
    return jsonify(ok=True)


@app.route("/api/location", methods=["POST"])
@require_node
def api_location():
    d = request.json or {}
    run(mc.commands.set_coords(float(d["lat"]), float(d["lon"])))
    run(mc.commands.send_appstart())
    return jsonify(ok=True)


@app.route("/api/time/sync", methods=["POST"])
@require_node
def api_time_sync():
    run(mc.commands.set_time(int(time.time())))
    return jsonify(ok=True, set=int(time.time()))


@app.route("/api/message", methods=["POST"])
@require_node
def api_message():
    d = request.json or {}
    text = (d.get("text") or "").strip()
    if not text:
        return jsonify(ok=False, error="empty message"), 400
    ch = int(d.get("channel", 0))
    run(mc.commands.send_chan_msg(ch, text))
    _add_msg(f"chan:{ch}", "out", text, "me")
    return jsonify(ok=True)


@app.route("/api/channels")
def api_channels():
    chans = [{"idx": i, "name": channels.get(i, "")} for i in sorted(channels)]
    if not chans:
        chans = [{"idx": 0, "name": ""}]
    return jsonify({"channels": chans})


@app.route("/api/channel", methods=["POST"])
@require_node
def api_set_channel():
    d = request.json or {}
    idx = int(d["idx"])
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify(ok=False, error="channel name required"), 400
    # Optional passphrase -> deterministic 16-byte key (a "private" channel).
    # If omitted, the library derives the key from the channel name (shared/by-name).
    secret = d.get("secret")
    secret_bytes = hashlib.sha256(secret.encode()).digest()[:16] if secret else None
    run(mc.commands.set_channel(idx, name, secret_bytes))
    try:
        ev = run(mc.commands.get_channel(idx))
        channels[idx] = (getattr(ev, "payload", {}) or {}).get("channel_name", name)
    except Exception:
        channels[idx] = name
    return jsonify(ok=True, idx=idx, name=channels.get(idx, name))


@app.route("/api/messages")
def api_messages():
    thread = request.args.get("thread", "chan:0")
    return jsonify({"thread": thread, "messages": list(messages.get(thread, []))})


@app.route("/api/threads")
def api_threads():
    out = []
    for idx in sorted(channels):
        thread = f"chan:{idx}"
        msgs = messages.get(thread, [])
        name = channels.get(idx, "")
        out.append({
            "thread": thread, "kind": "channel", "idx": idx,
            "label": name or ("Public" if idx == 0 else f"ch{idx}"),
            "count": len(msgs),
            "last_ts": msgs[-1]["ts"] if msgs else 0,
            "preview": msgs[-1]["text"][:48] if msgs else "",
        })
    for thread, msgs in messages.items():
        if thread.startswith("dm:") and msgs:
            out.append({
                "thread": thread, "kind": "dm", "prefix": thread.split(":", 1)[1],
                "label": thread.split(":", 1)[1],   # frontend maps prefix -> contact name
                "count": len(msgs),
                "last_ts": msgs[-1]["ts"],
                "preview": msgs[-1]["text"][:48],
            })
    out.sort(key=lambda x: -x["last_ts"])
    return jsonify({"threads": out})


@app.route("/api/dm", methods=["POST"])
@require_node
def api_dm():
    d = request.json or {}
    pubkey = (d.get("pubkey") or "").strip()
    text = (d.get("text") or "").strip()
    if not pubkey or not text:
        return jsonify(ok=False, error="pubkey and text required"), 400
    ev = run(mc.commands.send_msg(pubkey, text))
    payload = getattr(ev, "payload", {}) or {}
    ack = payload.get("expected_ack")
    ack_hex = ack.hex() if isinstance(ack, (bytes, bytearray)) else (ack if isinstance(ack, str) else None)
    m = _add_msg(f"dm:{pubkey[:12]}", "out", text, "me", status="sent", ack=ack_hex)
    if ack_hex:
        pending_acks[ack_hex] = m
    return jsonify(ok=True, ack=ack_hex)


@app.route("/api/trace", methods=["POST"])
def api_trace():
    if not DEMO and mc is None:
        return jsonify(ok=False, error="node not connected"), 503
    pubkey = (request.json or {}).get("pubkey", "")
    if DEMO:
        return jsonify(ok=True, flood=False, name=MOCK_CONTACTS.get(pubkey, {}).get("adv_name", "node"),
                       hops=[{"hash": "a3", "label": "DEMO-Repeater-9"},
                             {"hash": "7f", "label": "DEMO-Gateway-7F"}])
    # best-effort active discovery, then read the contact's resolved path
    try:
        run(mc.commands.send_path_discovery_sync(pubkey, timeout=8), timeout=14)
    except Exception:
        pass
    cdict = {}
    try:
        ev = run(mc.commands.get_contacts())
        cdict = _jsonable(getattr(ev, "payload", {}) or {})
    except Exception:
        pass
    c = cdict.get(pubkey) or next(
        (v for v in cdict.values() if str(v.get("public_key", "")).startswith(pubkey[:12])), {})
    opath = c.get("out_path", "") or ""
    olen = c.get("out_path_len", -1)
    flood = olen is None or olen < 0
    hops = [] if flood else [{"hash": opath[i:i + 2], "label": None} for i in range(0, len(opath), 2)]
    return jsonify(ok=True, flood=flood, name=c.get("adv_name") or "node", hops=hops)


@app.route("/api/reboot", methods=["POST"])
@require_node
def api_reboot():
    run(mc.commands.reboot())
    state["connected"] = False
    return jsonify(ok=True)


if __name__ == "__main__":
    print(f"\n  MeshDash  ->  http://127.0.0.1:{HTTP_PORT}\n")
    app.run(host="0.0.0.0", port=HTTP_PORT, threaded=True, use_reloader=False)
