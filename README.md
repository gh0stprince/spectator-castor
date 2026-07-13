# Spectator

**Twitch for your agent.** Spectator turns a running [Hermes Agent](https://github.com/NousResearch/hermes-agent) session into a shareable, read-only broadcast: streamed replies, live tool activity, approval moments, reconnect state, and viewer count.

Hermes stays on loopback. A small local tap observes its Desktop connection, converts private gateway frames into a deliberately small event format, scrubs that format, and sends only the safe result to browsers.

## The 10-second version

Node 20+ is required. There is one runtime dependency (`ws`) and no build step.

```bash
git clone https://github.com/gh0stprince/spectator-castor.git
cd spectator
npm install
npm test
npm run demo
```

Open the printed `/watch#k=…` URL. Demo mode loops a bundled session and does not need Hermes.

The package exposes a `spectator` command when installed globally or linked with `npm link`. The earlier `hermes-live` command remains as a compatibility alias. From a source checkout, the documented `npm run` commands need no global install.

## Why the tap exists

The first idea was simple: connect a second WebSocket client to Hermes and listen. Real Hermes v0.18.2 taught us that `/api/ws` is a private per-client stream. A passive client connects successfully but does not see the events being delivered to Desktop.

Spectator therefore uses an authenticated, loopback-only transparent proxy:

```text
Hermes Desktop ──HTTP/WS──► tap :9121 ──HTTP/WS──► Hermes :9119
                                │
                                │ copied server events only
                                ▼
                         normalize → redact → relay :8787 → viewers
```

Desktop still talks to Hermes normally. The tap forwards both directions unchanged, but only selected server events and the operator actions needed for display enter the viewer pipeline. All Hermes protocol knowledge remains in `src/adapter.js`.

## Windows operator runbook

Do **not** pin `HERMES_DASHBOARD_SESSION_TOKEN` in `~/.hermes/.env` or `%LOCALAPPDATA%\hermes\.env`. Hermes loads that file with override semantics; a pinned value replaces the fresh token Desktop passes to its own local backend and makes the next normal Desktop launch fail at WebSocket authentication. The operator script discovers the running dashboard's injected token over loopback for each run and never writes it to disk.

```powershell
# Terminal 1 — loopback-only Hermes backend
hermes dashboard --no-open

# Terminal 2 — Spectator and a managed Hermes Desktop
.\start-spectator.cmd

# Optional stable viewer key
.\start-spectator.cmd -ViewKey <your-view-key>
```

Keep the PowerShell window opened by the start script running. For deterministic shutdown, double-click `stop-spectator.cmd` or run it from another terminal. It closes Hermes first, waits for its own cleanup, and only then stops Spectator. Do not close the start window or use Task Manager as the normal shutdown path.

The same stop script is also the recovery path if the start window became stuck:

```powershell
.\stop-spectator.cmd
```

Both paths ask the temporary Hermes window to close normally first, allowing Electron's `before-quit` handler to flush state and stop its backend child. Spectator then shuts down and leaves Hermes closed. The temporary remote-mode environment existed only in that managed process, so the next launch from the normal Hermes shortcut is a clean standalone launch. A forced process-tree stop is reserved for an unresponsive emergency fallback. The separate `hermes dashboard` process is never targeted.

The scripts discover the dashboard token without printing or persisting it. Live history is stored as normalized, redacted events in the git-ignored `.spectator/` directory.

## Publish the viewer

Cloudflare Quick Tunnel is the currently supported public-link path:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Append the printed viewer path and fragment:

```text
https://<tunnel>.trycloudflare.com/watch#k=<viewer-key>
```

The `#k=` fragment is not included in the initial HTTP navigation or referrer. Viewer JavaScript uses it to authenticate the subsequent WebSocket upgrade. As with any hosted tunnel, the tunnel provider terminates the public TLS connection; use a random viewer key and stop the tunnel when the broadcast ends.

Tailscale is intentionally not included yet. Cloudflare gives the public, phone-friendly launch path we need; another networking mode would add documentation and support surface before we know it is useful.

## What viewers see

- Operator prompts and Hermes replies in chronological, session-scoped order.
- Streaming text with a live caret.
- Tool name, safe summary, running/completed/failed state, and approval resolution.
- Reconnecting and recovered states without refreshing the page.
- Viewer count and current model/session metadata.
- Persistent light and dark themes, defaulting to the viewer's system preference.

The viewer is a single self-contained HTML file. It requests no fonts, scripts, images, analytics, or other third-party assets.

## Safety boundary

Every event passes through `src/redact.js` before buffering, persistence, or fan-out.

- `sudo.request` and `secret.request` are dropped entirely.
- API keys, bearer tokens, JWTs, secret-looking environment lines, and long high-entropy values become `[redacted]`.
- Tool arguments, raw output, and private reasoning are hidden by default.
- Home-directory paths become `~`.
- The viewer is read-only; inbound WebSocket messages are ignored.
- The tap binds only to `127.0.0.1` and requires the Hermes dashboard token.
- The relay requires a separate viewer key and refuses an incorrect key with HTTP 401.
- Static responses use CSP, no-referrer, no-store, frame denial, MIME sniffing protection, and a restrictive permissions policy.

`--full-tool-output` is an explicit host opt-in. Secret scrubbing still applies, but the safest public default is names and summaries only.

`--persist` stores the already-normalized and already-redacted viewer stream. `--record` is different: it captures raw Hermes server frames for protocol work. Treat raw recordings as sensitive, keep them out of public links and commits, and delete them after verification.

Residual risk remains: Hermes can repeat private material in ordinary prose. Do not broadcast an agent working over data you would not show to the audience.

## What the real protocol looked like

Verified with **Hermes Agent v0.18.2 (2026.7.7.2)**.

Notifications arrived as:

```json
{"method":"event","params":{"type":"message.delta","session_id":"…","payload":{"text":"Hello"}}}
```

Important differences from the original guesses:

- The event name lives at `params.type`; the payload lives at `params.payload`.
- Message deltas carry text but usually no message ID, so Spectator creates restart-unique turn IDs.
- Tools use `tool_id`, `name`, `context`, `args`, and `result`.
- A successful one-time approval returns `approval.respond {choice:"once"}`, not the guessed `approve` value.
- `session.info` carries the model and running state.
- Hermes emits reasoning events; Spectator converts them to a generic thinking status and never exposes the text.

Unknown events degrade to status updates instead of crashing the broadcast.

## Acceptance evidence

The complete path was exercised end to end with real Hermes:

- Streamed replies reached the viewer in roughly one second.
- Tool cards appeared and resolved; approval decisions displayed correctly.
- Killing and restarting Hermes produced reconnect/recovery without a page refresh.
- A planted fake credential reached the public viewer only as `[redacted]`.
- Public WebSocket frames contained no planted key, privileged prompt events, raw tool fields, or reasoning.
- The persisted redacted stream contained no planted key; raw recording was disabled and removed.
- A wrong viewer key received HTTP 401.
- Managed start and shutdown are tested on Windows; teardown closes Hermes before Spectator and leaves the next launch standalone.
- Dark and light viewer states were rendered and visually checked against a real session.

Run the current suite with:

```bash
npm test
```

## Useful flags

```text
--port <n>                 viewer relay port (default 8787)
--hermes-url <url>         loopback Hermes backend
--token <value>            Hermes dashboard token
--tap-port <n>             authenticated Desktop tap
--manage-desktop           launch a temporary Hermes Desktop on Windows
--desktop-path <path>      override Desktop executable discovery
--close-desktop            close managed Desktop without relaunching
--restore-desktop          emergency standalone-Hermes recovery
--persist <path>           redacted event history
--view-key <key>           stable viewer key
--demo                     bundled no-Hermes session
--record                   sensitive raw protocol capture
--full-tool-output         opt in to scrubbed tool output
```

## Project map

```text
src/cli.js          startup, lifecycle, and operator output
src/desktop.js      managed Windows Desktop start/clean teardown
src/adapter.js      Hermes protocol client, normalizer, and tap proxy
src/redact.js       mandatory browser-facing safety layer
src/relay.js        viewer server, key auth, redacted history, fan-out
src/schema.js       the only event shape allowed into a browser
public/index.html   single-file responsive viewer
scripts/            Windows operator start/stop runbook
fixtures/           demo and reviewed normalized fixtures
test/               protocol, proxy, redaction, lifecycle, and UI invariants
```

## Scope

Spectator is read-only by design. No chat input, remote approvals, control surface, accounts, analytics, or general-purpose persistence. It stays focused on safely broadcasting one real agent session.

## Contributing and support

Bug reports and small, focused improvements are welcome in [GitHub Issues](https://github.com/gh0stprince/spectator-castor/issues). Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security problems should be reported privately as described in [SECURITY.md](SECURITY.md), not filed as public issues.

Spectator is an independent community project and is not affiliated with or endorsed by Nous Research.

Released under the [MIT License](LICENSE).
