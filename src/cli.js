#!/usr/bin/env node
// hermes-live — Twitch for your agent.
//   hermes-live                connect to a running Hermes backend and start broadcasting
//   hermes-live --demo         no Hermes needed: play a bundled session on loop
//   hermes-live --record       also dump raw gateway frames to fixtures/raw-frames.jsonl
// Flags: --port <relay port> --hermes-url <http://127.0.0.1:9119> --token <session token>
//        --full-tool-output   (off by default: viewers see tool names + summaries only)

import { Relay } from "./relay.js";
import { HermesAdapter, HermesTapProxy, probeHermes } from "./adapter.js";
import { startDemo } from "./demo.js";
import { HermesDesktopManager } from "./desktop.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const amber = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const port = Number(opt("port", 8787));
const hermesUrl = opt("hermes-url", process.env.HERMES_URL ?? "http://127.0.0.1:9119");
const token = opt("token", process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? "");
const viewKey = opt("view-key", process.env.SPECTATOR_VIEW_KEY ?? null);
const tapPort = Number(opt("tap-port", 0));
const persistPath = opt("persist", null);
const manageDesktop = flag("manage-desktop");
const desktopPath = opt("desktop-path", undefined);

if (flag("restore-desktop")) {
  const desktop = new HermesDesktopManager({ executable: desktopPath });
  await desktop.restoreNormal();
  console.log("Hermes Desktop restored to normal standalone mode.");
  process.exit(0);
}

const relay = new Relay({ port, viewKey, fullToolOutput: flag("full-tool-output"), persistPath });
await relay.start();
let adapter = null;
let desktop = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(dim(`\nStopping Spectator (${signal})…`));
  try {
    if (desktop) await desktop.stop();
    adapter?.stop();
    relay.stop();
    if (desktop) {
      desktop.launch(false);
      console.log("Hermes Desktop restored to normal standalone mode.");
    }
  } catch (err) {
    console.error(`Hermes restore failed: ${err.message}`);
    console.error(`Run: node src/cli.js --restore-desktop${desktopPath ? ` --desktop-path "${desktopPath}"` : ""}`);
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 150).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

if (flag("demo")) {
  startDemo(relay);
  console.log(`\n${bold("hermes-live")} ${dim("(demo mode — bundled session on loop)")}`);
} else {
  const status = await probeHermes(hermesUrl);
  if (!status) {
    console.error(`\nNo Hermes backend answering at ${hermesUrl}.\n`);
    console.error(`Start one first (loopback only — hermes-live handles exposure):`);
    console.error(amber(`  hermes serve`) + dim(`            # headless backend, or:`));
    console.error(amber(`  hermes dashboard --no-open`));
    console.error(`\nThen re-run with the session token:`);
    console.error(amber(`  HERMES_DASHBOARD_SESSION_TOKEN=<token> npx hermes-live`));
    console.error(dim(`\nOr try it without Hermes at all:  npx hermes-live --demo\n`));
    process.exit(1);
  }
  if (!token) {
    console.error(`\nConnected to Hermes at ${hermesUrl} but no token provided.`);
    console.error(`Set ${amber("HERMES_DASHBOARD_SESSION_TOKEN")} (pin one in ~/.hermes/.env so it survives restarts) or pass ${amber("--token")}.\n`);
    process.exit(1);
  }
  adapter = tapPort
    ? new HermesTapProxy({ upstreamUrl: hermesUrl, token, port: tapPort, recordPath: flag("record") ? "fixtures/raw-frames.jsonl" : null })
    : new HermesAdapter({ url: hermesUrl, token, recordPath: flag("record") ? "fixtures/raw-frames.jsonl" : null });
  adapter.on("event", (ev) => relay.ingest(ev));
  adapter.on("error", (err) => console.error(dim(`[adapter] ${err.message}`)));
  await adapter.start();
  if (manageDesktop) {
    if (!tapPort) throw new Error("--manage-desktop requires --tap-port");
    desktop = new HermesDesktopManager({
      executable: desktopPath,
      remoteUrl: `http://127.0.0.1:${tapPort}`,
      token,
    });
    await desktop.startManaged();
  }
  console.log(`\n${bold("hermes-live")} ${dim(`→ ${hermesUrl}`)}${tapPort ? amber(`  tap: http://127.0.0.1:${tapPort}`) : ""}${flag("record") ? amber("  ● recording raw frames") : ""}`);
}

console.log(`\n  Watch locally:  ${amber(relay.viewerUrl())}`);
console.log(`\n  Share publicly (run in another terminal):`);
console.log(amber(`    cloudflared tunnel --url http://localhost:${port}`));
console.log(dim(`    then share:  <tunnel-url>/watch#k=${relay.viewKey}\n`));
console.log(dim(`  Redaction is ON: secrets scrubbed, tool args/output hidden (names + summaries shown).`));
console.log(dim(`  Hermes itself is never exposed — only this relay.\n`));
if (desktop) console.log(dim(`  Hermes Desktop is managed: stopping Spectator restores normal standalone mode.\n`));
