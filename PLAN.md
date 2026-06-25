# MeshDash — Product Plan

> A local-first control deck and operations console for MeshCore LoRa nodes.
> This document is the strategic roadmap to take MeshDash from a capable hobby
> dashboard to a polished, reliable, feature-complete product.

---

## 1. Vision

**MeshDash is the best way to run, watch, and understand a MeshCore node from a
computer.** It connects to a USB companion node and turns the raw radio into a
clean, real-time operations console — messaging, telemetry, mapping, diagnostics
— that a newcomer can understand in 30 seconds and a power user can live in all day.

**Principles**

1. **Local-first & private** — talks to your node over USB, no cloud account, no
   data leaves the machine unless you choose. Bind to localhost by default.
2. **Real-time** — the mesh is live; the UI should be too. Push, don't poll.
3. **Never lose data** — messages, contacts, and telemetry persist across restarts.
4. **Honest** — telemetry never cries wolf (see the link-health lesson). Show what
   we know, flag uncertainty, never fake confidence.
5. **Dense but legible** — power-user information density with a clear visual
   hierarchy. Every pixel earns its place.
6. **Zero-friction to run** — `uv run python app.py`, no build step, no config files
   required to start.
7. **Resilient** — survives node reboots, USB drops, and bad packets without a crash
   or a stuck UI.

---

## 2. Current state (v0.x) — honest assessment

**What's solid**
- Stable backend: Flask + a background asyncio loop owning one serial connection,
  all device commands serialised behind a lock.
- Real features already shipped: live packet feed, mesh radar, battery gauge +
  history, editable radio, mesh map, channel + PM chat (sidebar, unread badges,
  delivery ticks), traceroute, contacts with new-node flash, link-health, demo mode.
- Demo mode (`MESHDASH_DEMO=1`) for hardware-free preview.
- uv-locked, reproducible deps. Published, anonymised history.

**What's weak / missing (the gap to "product")**
- **Transport**: browser *polls* 4 endpoints on timers. Should be server-push (SSE).
- **Persistence**: messages/contacts/telemetry live in memory — lost on restart.
- **Config UX**: settings scattered across cards; channel creation uses `prompt()`.
- **No node-detail view**: can't drill into a contact (signal history, path, distance).
- **No telemetry**: can't query a neighbour's battery/environment.
- **No search**: feed/contacts/messages aren't searchable.
- **No notifications**: new messages don't alert when the tab is backgrounded.
- **Resilience UX**: reconnects work, but the UI doesn't surface state/errors well.
- **No tests**, no structured logging, single-file backend & frontend.
- **Not installable** (PWA), limited mobile layout, no keyboard shortcuts.
- **Security**: unauthenticated, binds 0.0.0.0 — fine for localhost, not for exposure.

---

## 3. Target architecture

**Backend** (`app.py` → package)
- Flask for routing + **SSE** (`/api/stream`) for real-time push to the browser.
- Background asyncio loop owns the `meshcore` serial connection (unchanged core).
- **SQLite** (WAL) for messages, contacts, telemetry, and signal history.
- Modular layout: `radio.py` (connection/commands), `store.py` (persistence),
  `events.py` (fan-out to SSE), `api.py` (routes). Keep it import-light.
- Structured logging; health endpoint; graceful reconnect with surfaced state.

**Frontend** (`static/` → modules)
- Vanilla JS, no build, split into modules: `api.js`, `chat.js`, `map.js`,
  `charts.js`, `modals.js`, `ui.js`. ES modules, no framework.
- A small **design system**: CSS variables (done), reusable components (modal,
  toast, form controls, buttons, cards), consistent spacing/typography.
- **SSE client** with auto-reconnect; polling kept only as a fallback.
- **PWA**: manifest + service worker for offline shell + installability.
- Responsive: works on a phone (driving/field use).

---

## 4. Roadmap (phases)

Each phase is independently shippable and leaves the app fully working.

### Phase 1 — UX professionalization ✦ (in progress)
- Reusable **modal + form system** (kill all `prompt()`/`confirm()`).
- **Settings modal**: one clean place for identity, location, radio, TX, advert,
  clock, reboot — with validation and the meshat preset.
- **Channel manager**: proper form (name + optional secret), list/edit slots.
- **Node-detail modal**: click a contact → pubkey, type, location, distance from us,
  route/flood, last-heard, signal, with Message / Trace / Telemetry actions.
- Header **gear** + connection state polish; consistent buttons/toasts.

### Phase 2 — Persistence & history
- SQLite store; chat history, contacts, signal/telemetry survive restarts.
- Message search & infinite scroll; per-thread history.
- Export: messages (txt/json), contacts (csv/json), config backup.

### Phase 3 — Real-time & performance
- SSE event stream replaces polling; instant feed/chat/contacts updates.
- Diff-based rendering everywhere (no full re-renders); virtualised feed.
- Connection/health banner; offline + reconnect states.

### Phase 4 — Rich mesh features
- **Telemetry**: request & chart a neighbour's battery/temp/voltage.
- **Traceroute v2**: live `PATH_RESPONSE` + per-hop SNR via `send_trace`.
- **Map v2**: all-node markers with detail popups, your node, coverage, clustering.
- **Search** across feed / contacts / messages; filters & saved views.
- **Wardrive mode**: record RSSI+GPS → live coverage map → GPX/GeoJSON export.

### Phase 5 — Operations & reach
- **Notifications**: desktop + sound on new DMs/mentions (with mute).
- **Settings persistence** & multi-profile; **multi-node** (manage several).
- **Auth + HTTPS** option for safe non-localhost access.
- **PWA**: installable, offline shell; mobile-first layouts; keyboard shortcuts.

### Phase 6 — Quality, polish & docs
- Tests: backend (pytest) + a few frontend smoke tests; CI.
- Accessibility (contrast, focus, ARIA), i18n scaffold.
- Onboarding/empty states, in-app help, tooltips.
- Structured logging, error reporting, `/healthz`. Versioning & changelog.

---

## 5. Definition of done (quality bar)

Every feature ships only when:
- It works with **real hardware** and in **demo mode**.
- It **degrades gracefully** when the node is disconnected (no stuck spinners,
  no thrown errors in the console).
- It's **keyboard-reachable** and readable at mobile width.
- It **persists** anything a user would be upset to lose.
- It has an **empty state** and a **loading state**.
- No `prompt()`/`alert()`; all dialogs are styled modals.
- The change is committed with an anonymised author and the repo stays public-clean.

---

## 6. Design language

- **Theme**: dark "mesh terminal" — near-black, neon cyan/green/magenta accents,
  JetBrains Mono + Orbitron. Glassmorphism cards, subtle glows, live canvas accents.
- **Color semantics**: cyan = info/self, green = good/linked, amber = caution,
  red = error, magenta = peers/messages.
- **Components**: card, modal, form-field, button (primary/ghost/danger/mini),
  toast, badge, chip, gauge, chart, map. One source of truth in CSS.
- **Motion**: purposeful only (new-data flashes, radar sweep). Never gratuitous;
  never re-animate unchanged content (see the blink fix).

---

## 7. Non-goals (for now)
- Acting as a mesh **repeater/gateway** (that's the node's firmware job).
- Re-implementing the public meshat.se network map (link out instead).
- Cloud sync / accounts.
