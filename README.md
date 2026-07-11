# hermes-live

**Twitch for your agent.** One command turns a running [Hermes Agent](https://github.com/NousResearch/hermes-agent) session into a shareable link where anyone can watch it work — streaming responses, live tool-call cards, approval moments, and a viewer count. Read-only, redacted by default, and Hermes itself never touches the internet.

```
npx hermes-live --demo        # see it working in 10 seconds, no Hermes needed
```

## Why

Hermes's dashboard and desktop app are deliberately private, single-operator surfaces. There is no safe way to let someone *watch* your agent work. hermes-live adds a broadcast layer: your Hermes stays loopback-only, a small relay subscribes to its event stream, scrubs it, and fans it out to viewers.

## Run it against a real Hermes

```bash
# 1. Start a headless Hermes backend (loopback only — never expose this)
hermes serve                      # or: hermes dashboard --no-open

# 2. Broadcast it. For Hermes Desktop, enable the loopback tap proxy.
HERMES_DASHBOARD_SESSION_TOKEN=<token> npx hermes-live --tap-port 9121 --manage-desktop --persist .spectator/session-events.jsonl

# 3. Spectator launches Hermes Desktop through the authenticated local tap.
#    Press Ctrl+C when finished; it closes that temporary instance and reopens
#    Hermes normally. If Spectator was force-killed, recover with:
npx hermes-live --restore-desktop

# 4. Share it (separate terminal)
cloudflared tunnel --url http://localhost:8787
# post:  https://<tunnel>.trycloudflare.com/watch#k=<view key printed at startup>
```

The view key lives in the URL **fragment**, so it is never sent to the tunnel provider or logged by intermediaries. WebSocket upgrades without the key are refused.

### Windows operator start / stop

The included scripts keep Hermes recoverable and avoid leaving Desktop stuck in temporary remote mode:

```powershell
# First terminal: keep the loopback-only Hermes backend running
hermes dashboard --no-open

# Start Spectator and a managed Hermes Desktop
.\start-spectator.cmd

# Optional: keep a stable viewer key between starts
.\start-spectator.cmd -ViewKey <your-view-key>

# Normal stop: press Ctrl+C in the Spectator window.
# If that window was closed or force-stopped, run:
.\stop-spectator.cmd
```

The start script reads `HERMES_DASHBOARD_SESSION_TOKEN` from the environment, `~/.hermes/.env`, or `%LOCALAPPDATA%\hermes\.env` without printing it. The recovery script targets only Node running `src/cli.js --manage-desktop`. Desktop cleanup matches the exact Hermes Desktop executable path, so it cannot terminate `hermes dashboard`. Both shutdown paths reopen Hermes Desktop normally.

Flags: `--port <n>` · `--hermes-url <url>` · `--token <t>` · `--tap-port <n>` · `--manage-desktop` · `--desktop-path <path>` · `--restore-desktop` · `--persist <redacted.jsonl>` · `--view-key <key>` · `--demo` · `--record` · `--full-tool-output`

## Security model (read this before sharing a link)

- **Hermes is never exposed.** Only the relay is, and only if you start a tunnel.
- **The tap is loopback-only.** It binds explicitly to `127.0.0.1`, requires the Hermes session token on HTTP and WebSocket requests, and is never tunneled.
- **Desktop state is restored.** On Windows, `--manage-desktop` keeps the remote URL/token in the temporary Desktop process environment only. Normal Ctrl+C/SIGTERM shutdown closes every helper belonging to that exact Desktop executable, stops the tap, and reopens Hermes without the remote variables. `--restore-desktop` provides the same recovery after a forced kill; the Python Hermes backend is never terminated by this cleanup.
- **Read-only.** The viewer socket ignores all inbound frames. Nobody can prompt, approve, or control anything through a share link.
- **Redaction is on by default** (`src/redact.js`):
  - `sudo.request` / `secret.request` events are dropped before they can reach any viewer.
  - API-key shapes, bearer tokens, JWTs, `KEY=value` secret lines, and high-entropy blobs are replaced with `[redacted]` in every string, recursively.
  - Tool **arguments and raw output are hidden** — viewers see tool names and one-line summaries. Opt in to full output with `--full-tool-output` (still secret-scrubbed).
  - Your home directory path is rewritten to `~`.
- Residual risk you accept: the agent's *prose* can mention anything it read. Don't broadcast sessions over private material.
- `--persist` stores only the already-normalized, already-redacted viewer events. It never stores dropped prompt kinds, raw tool arguments/output, or reasoning text.
- `--record` is different: it records raw Hermes server frames for protocol verification. Treat that fixture as sensitive and do not publish it until reviewed.

## Verifying against your Hermes build (do this once)

The relay speaks the `tui_gateway` JSON-RPC/WebSocket protocol used by Hermes Desktop and the dashboard. Hermes v0.18.2 gives each `/api/ws` client a private event stream, so a second passive client cannot observe Desktop. In `--tap-port` mode, Desktop connects through an authenticated loopback HTTP/WebSocket proxy; the proxy forwards traffic unchanged and copies only server→Desktop event frames into the normalizer. Event payloads can drift between releases, so:

```bash
npx hermes-live --record        # dumps raw frames to fixtures/raw-frames.jsonl
# drive one full task from the TUI / desktop / Telegram, then inspect the file
```

Verified on **Hermes Agent v0.18.2 (2026.7.7.2)**. Real notifications use `{method:"event", params:{type, session_id, payload}}`. Message deltas contain `{text}` with no message id; tool events use `tool_id`, `name`, `context`, `args`, and `result`; approvals contain no approval id and successful one-time decisions arrive from Desktop as `approval.respond {choice:"once"}`. The adapter generates per-turn message ids, treats `once`/`always` as approved, and maps `session.info` into viewer metadata. Unknown event types degrade to ticker updates instead of breaking the viewer.

## Architecture

```
Hermes Desktop ──HTTP/WS──► tap :9121 ──HTTP/WS──► Hermes :9119
                                │ server events
                                ▼
                             adapter ──normalize──► redact ──► relay :8787
                                                                  │
                                  browser viewers ◄──ws /ws?key──┘
```

- `src/schema.js` — the normalized `WireEvent` shape; nothing else ever reaches a browser
- `src/adapter.js` — Hermes WS client + authenticated loopback tap + tolerant event mapping + `--record`
- `src/redact.js` — the module that makes public links safe (tested in `test/`)
- `src/relay.js` — static viewer + authenticated fan-out + 5,000-event backfill ring
- `public/index.html` — the broadcast viewer, zero build step

## Roadmap

Rooms (multiple humans, one agent), a session-export replay player, and an approval deck are built on this same event wire. This repo stays read-only spectate on purpose.

MIT.
