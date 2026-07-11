import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { HermesAdapter, HermesTapProxy } from "../src/adapter.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test("tap proxy is loopback-only, authenticated, bidirectional, and observes server frames", { timeout: 5000 }, async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (req, socket, head) => {
    upstreamWss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        assert.equal(String(data), "desktop-command");
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: { type: "message.delta", payload: { id: "m1", text: "hello" } },
        }));
      });
    });
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;

  const tap = new HermesTapProxy({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    token: "tap-test-token",
    port: 0,
  });
  await tap.start();
  const tapPort = tap.server.address().port;
  t.after(async () => {
    tap.stop();
    for (const ws of upstreamWss.clients) ws.terminate();
    upstream.closeAllConnections();
    await close(upstream);
  });

  const unauthorized = await fetch(`http://127.0.0.1:${tapPort}/api/status`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`http://127.0.0.1:${tapPort}/api/status`, {
    headers: { "x-hermes-session-token": "tap-test-token" },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { ok: true, path: "/api/status" });

  const ws401 = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${tapPort}/api/ws?token=wrong`);
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("error", () => {});
  });
  assert.equal(ws401, 401);

  const normalized = new Promise((resolve) => {
    const onEvent = (event) => {
      if (event.kind === "message.delta") { tap.off("event", onEvent); resolve(event); }
    };
    tap.on("event", onEvent);
  });
  const downstreamFrame = new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${tapPort}/api/ws?token=tap-test-token`);
    ws.on("open", () => ws.send("desktop-command"));
    ws.on("message", (data) => { resolve(JSON.parse(String(data))); ws.close(); });
    ws.on("error", reject);
  });
  const [event, raw] = await Promise.all([normalized, downstreamFrame]);
  assert.equal(raw.params.type, "message.delta");
  assert.equal(event.kind, "message.delta");
  assert.deepEqual(event.payload, { messageId: "m1", text: "hello" });
  assert.equal(tap.server.address().address, "127.0.0.1");
});

test("adapter maps client prompts but never exposes reasoning text", () => {
  const adapter = new HermesAdapter({ url: "http://127.0.0.1:1", token: "unused" });
  const events = [];
  adapter.on("event", (event) => events.push(event));
  adapter.ingestClientRaw(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "prompt.submit",
    params: { session_id: "s1", text: "hello" },
  }));
  adapter.ingestRaw(JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "reasoning.available", session_id: "s1", payload: { text: "private reasoning" } },
  }));
  assert.equal(events[0].kind, "user.message");
  assert.equal(events[0].payload.text, "hello");
  assert.equal(events[1].kind, "status");
  assert.ok(!JSON.stringify(events).includes("private reasoning"));
});

test("adapter treats Hermes once/always approval choices as approved", () => {
  const adapter = new HermesAdapter({ url: "http://127.0.0.1:1", token: "unused" });
  const events = [];
  adapter.on("event", (event) => events.push(event));
  for (const choice of ["once", "always", "deny"]) {
    adapter.ingestClientRaw(JSON.stringify({ method: "approval.respond", params: { choice } }));
  }
  assert.deepEqual(events.map((event) => event.payload.decision), ["approve", "approve", "deny"]);
});

test("adapter derives safe tool status from real Hermes result shape", () => {
  const adapter = new HermesAdapter({ url: "http://127.0.0.1:1", token: "unused" });
  const events = [];
  adapter.on("event", (event) => events.push(event));
  adapter.ingestRaw(JSON.stringify({
    method: "event",
    params: { type: "tool.complete", payload: {
      tool_id: "t1", name: "terminal", duration_s: 1.25,
      result: { exit_code: 2, error: "failed", output: "private output" },
    } },
  }));
  assert.equal(events[0].payload.status, "error");
  assert.equal(events[0].payload.summary, "terminal failed (exit 2) in 1.3s");
  assert.equal(events[0].payload.output.output, "private output");
});
