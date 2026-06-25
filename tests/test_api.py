"""API smoke tests for MeshDash — run against the in-process app in demo mode
(no radio hardware needed):  uv run pytest
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MESHDASH_DEMO"] = "1"

import app as appmod  # noqa: E402

client = appmod.app.test_client()


def test_status():
    d = client.get("/api/status").get_json()
    assert d["demo"] is True
    assert "link" in d and "self_info" in d
    assert d["self_info"]["name"] == "MeshDash-Demo"


def test_contacts_seeded():
    d = client.get("/api/contacts").get_json()
    # demo reveals the 5th node a few seconds in (to showcase the NEW flash)
    assert len(d) in (4, 5)
    assert any(v["adv_name"] == "DEMO-Relay-01" for v in d.values())


def test_channels():
    names = [c["name"] for c in client.get("/api/channels").get_json()["channels"]]
    assert "Public" in names


def test_threads_include_public():
    threads = client.get("/api/threads").get_json()["threads"]
    assert any(t["thread"] == "chan:0" for t in threads)


def test_messages_public():
    d = client.get("/api/messages?thread=chan:0").get_json()
    assert d["thread"] == "chan:0"
    assert len(d["messages"]) >= 1
    # internal ids never leak
    assert all(not any(k.startswith("_") for k in m) for m in d["messages"])


def test_search_hit_and_empty():
    d = client.get("/api/search?q=coffee").get_json()
    assert any("coffee" in m["text"].lower() for m in d["results"])
    assert client.get("/api/search?q=").get_json()["results"] == []


def test_export_is_json_download():
    r = client.get("/api/export/messages")
    assert r.status_code == 200
    assert r.mimetype == "application/json"
    assert "attachment" in r.headers.get("Content-Disposition", "")


def test_telemetry_mock():
    d = client.post("/api/telemetry", json={"pubkey": "x"}).get_json()
    assert d["ok"] and any(x["type"] == "voltage" for x in d["lpp"])


def test_trace_mock():
    d = client.post("/api/trace", json={"pubkey": "x"}).get_json()
    assert d["ok"] and "hops" in d


def test_command_post_accepted_in_demo():
    assert client.post("/api/advert", json={"flood": False}).get_json().get("ok")


def test_sw_and_manifest_served():
    assert client.get("/sw.js").status_code == 200
    assert client.get("/static/manifest.webmanifest").status_code == 200


def test_auth_gate(monkeypatch):
    monkeypatch.setattr(appmod, "AUTH_PW", "secret")
    c = appmod.app.test_client()
    assert c.get("/", follow_redirects=False).status_code == 302          # UI -> login
    assert c.get("/api/status").status_code == 401                        # API -> 401
    assert c.post("/login", data={"password": "nope"}).status_code == 200  # wrong pw
    r = c.post("/login", data={"password": "secret"}, follow_redirects=False)
    assert r.status_code == 302                                           # logged in
    assert c.get("/api/status").status_code == 200                        # now allowed
