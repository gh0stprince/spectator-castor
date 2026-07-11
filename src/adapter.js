// Hermes adapter: connects to a local `hermes serve` / dashboard backend at
// ws://127.0.0.1:<port>/api/ws?token=... and normalizes gateway events into WireEvents.
//
// ⚠ PROTOCOL NOTE — READ BEFORE EDITING ⚠
// The tui_gateway protocol is what Nous's own desktop app and web dashboard speak
// (see apps/shared in NousResearch/hermes-agent — JsonRpcGatewayClient). The event
// NAMES below come from the official docs (message.delta, tool.start, approval.request,
// gateway.ready, …) but the exact PAYLOAD shapes must be verified against your build:
//
//   1. run:  hermes-live --record
//   2. drive one full task in the TUI / desktop / Telegram
//   3. inspect fixtures/raw-frames.jsonl
//   4. adjust pickText/pickName below if fields differ, and commit the fixtures
//
// The normalizer is deliberately tolerant: unknown events become `status` events
// instead of being dropped, so the viewer degrades gracefully on protocol drift.

import WebSocket from "ws";
import { WebSocketServer } from "ws";
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkEvent, AGENT } from "./schema.js";

const first = (...vals) => vals.find((v) => v !== undefined && v !== null);

// Field-guessing helpers, isolated so fixture-driven fixes touch one place.
const pickText = (p = {}) => first(p.text, p.delta, p.content, p.chunk, p.message, "");
const pickName = (p = {}) => first(p.name, p.tool, p.tool_name, p.title, "tool");
const pickId = (p = {}, fallback) => String(first(p.id, p.tool_id, p.toolId, p.call_id, p.approval_id, p.request_id, fallback));
const pickSummary = (p = {}) => first(p.summary, p.context, p.description, p.command, p.label, "");
const completionFailed = (p = {}) => Boolean(
  p.error || p.status === "error" || p.result?.error ||
  (Number.isFinite(Number(p.result?.exit_code)) && Number(p.result.exit_code) !== 0)
);
const pickCompletionSummary = (p = {}) => {
  if (pickSummary(p)) return pickSummary(p);
  const bits = [pickName(p), completionFailed(p) ? "failed" : "succeeded"];
  if (Number.isFinite(Number(p.result?.exit_code))) bits.push(`(exit ${Number(p.result.exit_code)})`);
  if (p.duration_s) bits.push(`in ${Number(p.duration_s).toFixed(1)}s`);
  return bits.join(" ");
};

export class HermesAdapter extends EventEmitter {
  constructor({ url, token, agentName = "hermes", recordPath = null }) {
    super();
    this.wsUrl = `${url.replace(/^http/, "ws").replace(/\/$/, "")}/api/ws?token=${encodeURIComponent(token)}`;
    this.agent = AGENT(agentName);
    this.recordStream = recordPath ? fs.createWriteStream(recordPath, { flags: "a" }) : null;
    this.sessionId = "live";
    this.backoff = 500;
    this.closed = false;
    this.rpcId = 0;
    this.messageSeq = 0;
    this.currentMessageId = null;
  }

  start() {
    this._connect();
    return this;
  }

  stop() {
    this.closed = true;
    this.ws?.close();
    this.recordStream?.end();
  }

  _emit(kind, payload, actor = this.agent) {
    this.emit("event", mkEvent(this.sessionId, actor, kind, payload));
  }

  _connect() {
    this._emit("status", { state: this.backoff > 500 ? "reconnecting" : "connecting" });
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = 500;
      this._emit("status", { state: "live" });
    });

    ws.on("message", (buf) => {
      // newline-delimited JSON-RPC; be tolerant of single frames too
      this.ingestRaw(buf);
    });

    ws.on("close", (code) => {
      if (this.closed) return;
      this._emit("status", { state: "reconnecting", detail: `socket closed (${code})` });
      setTimeout(() => this._connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    });

    ws.on("error", (err) => {
      this.emit("error", err);
      // 'close' follows and drives the retry
    });
  }

  rpc(method, params = {}) {
    const id = ++this.rpcId;
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return id;
  }

  /** Record and normalize raw Hermes server frames. */
  ingestRaw(buf) {
    for (const line of buf.toString().split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (this.recordStream) this.recordStream.write(t + "\n");
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      this._handle(msg);
    }
  }

  /** Observe selected Desktop→Hermes RPCs without recording raw request data. */
  ingestClientRaw(buf) {
    for (const line of buf.toString().split("\n")) {
      let msg;
      try { msg = JSON.parse(line.trim()); } catch { continue; }
      const p = msg.params ?? {};
      if (p.session_id) this.sessionId = String(p.session_id);
      if (msg.method === "prompt.submit") {
        this._emit("user.message", { text: String(p.text ?? "") }, { type: "human", id: "operator", name: "operator" });
      } else if (msg.method === "approval.respond") {
        const choice = String(p.choice ?? p.decision ?? "resolved");
        this._emit("approval.decision", {
          approvalId: pickId(p, "a0"),
          decision: ["approve", "approved", "once", "always"].includes(choice) ? "approve" : "deny",
        }, { type: "human", id: "operator", name: "operator" });
      }
    }
  }

  _handle(msg) {
    // Current Hermes builds use a generic event notification envelope:
    // { method: "event", params: { type: "<event name>", payload: {...} } }.
    // Keep accepting the older direct-method shape for recorded fixture replay and
    // compatibility with pre-v0.18 gateways.
    const envelope = msg.method === "event" && msg.params?.type
      ? msg.params
      : null;
    const method = envelope?.type ?? msg.method;
    if (!method) return; // responses to our own rpc calls — ignore for spectate
    const p = envelope?.payload ?? msg.params ?? {};
    if (envelope?.session_id) this.sessionId = String(envelope.session_id);

    switch (method) {
      case "gateway.ready":
        this._emit("session.meta", {
          title: first(p.title, p.session_title, "Hermes session"),
          model: first(p.model, p.model_name, ""),
          startedAt: Date.now(),
        });
        this._emit("status", { state: "idle" });
        break;

      case "message.delta":
        this.currentMessageId ??= `m${++this.messageSeq}`;
        this._emit("message.delta", { messageId: pickId(p, this.currentMessageId), text: pickText(p) });
        this._emit("status", { state: "thinking" });
        break;

      case "message.complete":
        this.currentMessageId ??= `m${++this.messageSeq}`;
        this._emit("message.complete", { messageId: pickId(p, this.currentMessageId), text: pickText(p) });
        this.currentMessageId = null;
        this._emit("status", { state: "idle" });
        break;

      case "session.info":
        this._emit("session.meta", {
          title: first(p.title, "Hermes session"),
          model: [p.provider, p.model].filter(Boolean).join(" / "),
          startedAt: Date.now(),
        });
        this._emit("status", { state: p.running ? "thinking" : "idle" });
        break;

      case "thinking.delta":
      case "reasoning.available":
        // Do not broadcast private chain-of-thought/reasoning text.
        this._emit("status", { state: "thinking" });
        break;

      case "tool.start":
        this._emit("tool.start", { toolId: pickId(p, "t0"), name: pickName(p), summary: pickSummary(p), args: p.args ?? p.arguments });
        this._emit("status", { state: "tooling", detail: pickName(p) });
        break;

      case "tool.progress":
        this._emit("tool.progress", { toolId: pickId(p, "t0"), chunk: pickText(p) });
        break;

      case "tool.complete":
        this._emit("tool.complete", {
          toolId: pickId(p, "t0"),
          status: completionFailed(p) ? "error" : "ok",
          summary: pickCompletionSummary(p),
          output: p.output ?? p.result,
        });
        break;

      case "tool.output_risk":
        // Risk metadata can contain excerpts of raw tool output. Keep it local.
        break;

      case "approval.request":
        this._emit("approval.request", { approvalId: pickId(p, "a0"), name: pickName(p), summary: pickSummary(p) });
        this._emit("status", { state: "waiting", detail: "approval required" });
        break;

      case "clarify.request":
        this._emit("clarify.request", { text: pickText(p) });
        this._emit("status", { state: "waiting", detail: "question for the operator" });
        break;

      // must never reach viewers — emitted anyway; the redactor drops them,
      // and DROP_KINDS is the single source of truth for that policy.
      case "sudo.request":
      case "secret.request":
        break;

      default:
        this._emit("status", { state: "live", detail: method });
    }
  }
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function safeEqual(a, b) {
  const aa = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requestToken(req, url) {
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken;
  const hermesToken = req.headers["x-hermes-session-token"];
  if (hermesToken) return hermesToken;
  const auth = req.headers.authorization ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function closePeer(ws, code, reason) {
  if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) return;
  const safeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
  ws.close(safeCode, reason);
}

/**
 * Loopback-only transparent tap used when Hermes clients have private /api/ws
 * streams. Desktop connects here; HTTP and WS traffic is forwarded to Hermes,
 * while only server→Desktop WS frames enter the normalized/redacted viewer path.
 */
export class HermesTapProxy extends EventEmitter {
  constructor({ upstreamUrl, token, port = 9121, recordPath = null }) {
    super();
    this.upstream = new URL(upstreamUrl);
    this.token = token;
    this.port = port;
    this.normalizer = new HermesAdapter({ url: upstreamUrl, token, recordPath });
    this.normalizer.on("event", (ev) => this.emit("event", ev));
    this.normalizer.on("error", (err) => this.emit("error", err));
  }

  start() {
    this.server = http.createServer((req, res) => this._forwardHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => this._upgrade(req, socket, head));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve(this);
      });
    });
  }

  stop() {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    this.server?.closeAllConnections?.();
    this.server?.close();
    this.normalizer.stop();
  }

  _authorized(req, url) {
    return Boolean(this.token) && safeEqual(requestToken(req, url), this.token);
  }

  _forwardHttp(req, res) {
    const incoming = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (!this._authorized(req, incoming)) {
      res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Unauthorized");
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name) && name !== "host") headers[name] = value;
    }
    const upstreamReq = http.request({
      protocol: this.upstream.protocol,
      hostname: this.upstream.hostname,
      port: this.upstream.port,
      method: req.method,
      path: incoming.pathname + incoming.search,
      headers: { ...headers, host: this.upstream.host },
    }, (upstreamRes) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("Hermes backend unavailable");
    });
    req.on("aborted", () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }

  _upgrade(req, socket, head) {
    const incoming = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (incoming.pathname !== "/api/ws" || !this._authorized(req, incoming)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const upstreamUrl = new URL(incoming.pathname + incoming.search, this.upstream);
    upstreamUrl.protocol = this.upstream.protocol === "https:" ? "wss:" : "ws:";
    this.normalizer._emit("status", { state: "connecting" });
    const upstream = new WebSocket(upstreamUrl, { headers: { origin: "http://127.0.0.1" } });
    let downstream;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.destroy();
    };
    upstream.once("error", fail);
    upstream.once("open", () => {
      if (settled) return;
      settled = true;
      upstream.off("error", fail);
      this.normalizer._emit("status", { state: "live" });
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        downstream = ws;
        ws.on("message", (data, binary) => {
          this.normalizer.ingestClientRaw(data);
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        });
        upstream.on("message", (data, binary) => {
          this.normalizer.ingestRaw(data);
          if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary });
        });
        ws.on("close", (code, reason) => closePeer(upstream, code, reason));
        upstream.on("close", (code, reason) => {
          this.normalizer._emit("status", { state: "reconnecting", detail: `Hermes socket closed (${code})` });
          closePeer(ws, code, reason);
        });
        ws.on("error", () => upstream.close());
        upstream.on("error", () => ws.close(1011, "upstream error"));
      });
    });
  }
}

/** Probe a Hermes backend's HTTP status endpoint. Returns parsed JSON or null. */
export async function probeHermes(url) {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/status`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}
