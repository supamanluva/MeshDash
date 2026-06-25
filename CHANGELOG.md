# Changelog

## 1.0.0

A polished, feature-complete local control deck for a USB-connected MeshCore
companion node — built out across six planned phases (see `PLAN.md`).

### Core
- Flask + a background asyncio loop owning one serial connection; all device
  commands serialised behind a lock. Hardware-free **demo mode** (`MESHDASH_DEMO=1`).
- **SQLite** persistence: chat history survives restarts; full-text **search** and
  JSON **export**.

### Messaging
- Channel + 1-to-1 **PM chat** with a thread sidebar, **unread badges**, and
  **delivery ticks** (sent ✓ / delivered ✓✓ via mesh ACKs).
- **Notifications** — opt-in desktop + sound alerts on new messages.

### Mesh
- Live **packet feed**, **mesh radar**, **battery + signal** charts, and an honest
  **link-health** verdict (LINKED / RX OK / QUIET).
- Live **mesh map** (every node, clickable), **node detail** (type, distance, route),
  **telemetry** (neighbour battery/temp/humidity), and **traceroute**.
- **Contacts** with a new-node flash and a live filter.

### UX & operations
- Reusable **modal system**; consolidated **settings**; **channel manager**.
- **Keyboard shortcuts**, **mobile-responsive** layout, **accessibility** (ARIA, focus).
- Installable **PWA** (manifest + service worker, offline shell).
- Optional **password auth** (login + signed session); **pytest** API suite.
