// Relay: one event source in (Hermes adapter or demo player), N browser viewers out.
// Hermes stays loopback-only; only this process is ever exposed (via a tunnel you start).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { redactEvent } from "./redact.js";
import { mkEvent, SYSTEM, KINDS } from "./schema.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const RING_MAX = 5000;

export class Relay {
  constructor({ port = 8787, viewKey = null, fullToolOutput = false, persistPath = null } = {}) {
    this.port = port;
    this.viewKey = viewKey ?? crypto.randomBytes(16).toString("hex");
    this.fullToolOutput = fullToolOutput;
    this.ring = [];       // redacted events, seq-stamped
    this.seq = 0;
    this.viewers = new Set();
    this.sessionId = "live";
    this.lastStatusSignature = "";
    this.lastPresence = null;
    this.persistPath = persistPath;
    if (persistPath && fs.existsSync(persistPath)) {
      for (const line of fs.readFileSync(persistPath, "utf8").split("\n")) {
        try {
          const ev = JSON.parse(line);
          if (ev && KINDS.has(ev.kind) && ev.payload && typeof ev.payload === "object") this.ring.push(ev);
        } catch {}
      }
      this.ring = this.ring.slice(-RING_MAX);
      this.seq = this.ring.reduce((max, ev) => Math.max(max, Number(ev.seq) || 0), 0);
    }
    if (persistPath) {
      fs.mkdirSync(path.dirname(path.resolve(persistPath)), { recursive: true });
      this.persistStream = fs.createWriteStream(persistPath, { flags: "a" });
    }
  }

  /** Feed one raw WireEvent in. Redacts, stamps seq, buffers, broadcasts. */
  ingest(ev) {
    const red = redactEvent(ev, { fullToolOutput: this.fullToolOutput });
    if (!red) return; // dropped by policy
    if (red.kind === "status") {
      const signature = JSON.stringify([red.payload.state, red.payload.detail ?? ""]);
      if (signature === this.lastStatusSignature) return;
      this.lastStatusSignature = signature;
    } else if (red.kind === "presence.state") {
      if (red.payload.viewers === this.lastPresence) return;
      this.lastPresence = red.payload.viewers;
    }
    red.seq = ++this.seq;
    this.ring.push(red);
    if (this.ring.length > RING_MAX) this.ring.shift();
    const frame = JSON.stringify(red);
    this.persistStream?.write(frame + "\n");
    for (const ws of this.viewers) if (ws.readyState === ws.OPEN) ws.send(frame);
  }

  _broadcastPresence() {
    this.ingest(mkEvent(this.sessionId, SYSTEM, "presence.state", { viewers: this.viewers.size }));
  }

  start() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/healthz") { res.end("ok"); return; }
      // static viewer
      const file = url.pathname === "/" || url.pathname.startsWith("/watch")
        ? "index.html"
        : path.basename(url.pathname);
      const fp = path.join(PUBLIC_DIR, file);
      if (!fp.startsWith(PUBLIC_DIR) || !fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      res.writeHead(200, {
        "content-type": types[path.extname(fp)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      fs.createReadStream(fp).pipe(res);
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname !== "/ws" || url.searchParams.get("key") !== this.viewKey) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.viewers.add(ws);
        // backfill: everything in the ring, optionally from ?since=<seq>
        const since = Number(url.searchParams.get("since") ?? 0);
        for (const ev of this.ring) if (ev.seq > since) ws.send(JSON.stringify(ev));
        this._broadcastPresence();
        ws.on("close", () => { this.viewers.delete(ws); this._broadcastPresence(); });
        ws.on("message", () => {}); // read-only surface: inbound frames ignored
      });
    });

    this.presenceTimer = setInterval(() => { if (this.viewers.size) this._broadcastPresence(); }, 5000);
    return new Promise((resolve) => this.server.listen(this.port, "0.0.0.0", () => resolve(this)));
  }

  stop() {
    clearInterval(this.presenceTimer);
    for (const ws of this.viewers) ws.close();
    this.wss?.close();
    this.server?.close();
    this.persistStream?.end();
  }

  viewerUrl(base = `http://localhost:${this.port}`) {
    return `${base}/watch#k=${this.viewKey}`;
  }
}
