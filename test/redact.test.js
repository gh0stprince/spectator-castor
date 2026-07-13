import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubString, redactEvent } from "../src/redact.js";
import { mkEvent, AGENT } from "../src/schema.js";
import { Relay } from "../src/relay.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const ev = (kind, payload) => ({ ...mkEvent("s", AGENT(), kind, payload) });
const joined = (...parts) => parts.join("");

const fakeOpenAiKey = joined("sk-", "abc123def456ghi789jkl012");
const fakeGitHubToken = joined("ghp_", "ABCdef1234567890ABCdef12345");
const fakeSlackToken = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
const fakeAwsKey = joined("AKIA", "IOSFODNN7EXAMPLE");
const fakeBearerToken = joined("Bearer ", "sk_live_", "abcdef1234567890abcdef");
const fakeJwt = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P",
].join(".");

test("scrubs provider key shapes", () => {
  const nasty = [
    fakeOpenAiKey,
    fakeGitHubToken,
    fakeSlackToken,
    fakeAwsKey,
    fakeBearerToken,
    fakeJwt,
  ];
  for (const s of nasty) {
    const out = scrubString(`before ${s} after`);
    assert.ok(!out.includes(s), `leaked: ${s} -> ${out}`);
    assert.ok(out.includes("[redacted]"));
  }
});

test("provider-key replacement contains no match-offset artifact", () => {
  const fakeKey = joined("sk-", "unit1234567890abcdefghij");
  assert.equal(
    scrubString(joined("Here's my API key ", fakeKey, "; check it.")),
    "Here's my API key [redacted]; check it.",
  );
});

test("scrubs env-style secret lines but keeps the key name", () => {
  const out = scrubString("OPENAI_API_KEY=sk-something\nDEBUG=true");
  assert.ok(out.includes("OPENAI_API_KEY=[redacted]"));
  assert.ok(out.includes("DEBUG=true"));
});

test("leaves normal prose and code alone", () => {
  const s = "run `npm test` in ./src and check exit code 1";
  assert.equal(scrubString(s), s);
});

test("drops sudo.request and secret.request entirely", () => {
  // constructed raw (bypassing KINDS check) the way a future adapter bug might
  for (const kind of ["sudo.request", "secret.request"]) {
    const raw = { ...ev("status", {}), kind };
    assert.equal(redactEvent(raw), null, `${kind} must be dropped`);
  }
});

test("hides tool args and output by default", () => {
  const started = redactEvent(ev("tool.start", { toolId: "t1", name: "terminal", summary: "ls", args: { cmd: "cat ~/.hermes/.env" } }));
  assert.equal(started.payload.args, undefined);
  assert.equal(started.payload.argsHidden, true);

  const done = redactEvent(ev("tool.complete", { toolId: "t1", status: "ok", summary: "ok", output: "SECRET_TOKEN=abc" }));
  assert.equal(done.payload.output, undefined);
  assert.equal(done.payload.outputHidden, true);
});

test("full-tool-output mode still scrubs secrets inside output", () => {
  const done = redactEvent(
    ev("tool.complete", { toolId: "t1", status: "ok", summary: "ok", output: joined("token: ", fakeGitHubToken) }),
    { fullToolOutput: true },
  );
  assert.ok(!JSON.stringify(done).includes(joined("ghp_", "ABCdef")));
});

test("truncates oversized progress chunks in default mode", () => {
  const big = "line of build output with words\n".repeat(80);
  const out = redactEvent(ev("tool.progress", { toolId: "t1", chunk: big }));
  assert.ok(out.payload.chunk.length < 500);
  assert.ok(out.payload.chunk.endsWith("[truncated]"));
});

test("redacted persistence survives restart without storing raw secrets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spectator-test-"));
  const persistPath = path.join(dir, "events.jsonl");
  const relay = new Relay({ persistPath });
  relay.ingest(ev("user.message", { text: joined("key ", fakeOpenAiKey) }));
  relay.ingest({ ...ev("status", {}), kind: "secret.request" });
  relay.persistStream.end();
  await once(relay.persistStream, "finish");
  const disk = fs.readFileSync(persistPath, "utf8");
  assert.ok(disk.includes("[redacted]"));
  assert.ok(!disk.includes(joined("sk-", "abc123")));
  assert.ok(!disk.includes("secret.request"));
  const restored = new Relay({ persistPath });
  assert.equal(restored.ring.length, 1);
  restored.persistStream.end();
  await once(restored.persistStream, "finish");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scrubs email, phone, ipv4, mac, and SSN-shaped PII", () => {
  const cases = [
    ["contact me at ada.lovelace@example.com today", "ada.lovelace@example.com", "[email redacted]"],
    ["call 415-555-0199 anytime", "415-555-0199", "[phone redacted]"],
    ["call +1 415-555-0199 anytime", "415-555-0199", "[phone redacted]"],
    ["server 10.0.42.7 went down", "10.0.42.7", "[ipv4 redacted]"],
    ["device aa:bb:cc:dd:ee:ff joined", "aa:bb:cc:dd:ee:ff", "[mac redacted]"],
    ["SSN 123-45-6789 on file", "123-45-6789", "[ssn redacted]"],
    ["run-together 4155550199 number", "4155550199", "[phone redacted]"],
    ["parenthesized (415) 555-0199 ok", "555-0199", "[phone redacted]"],
    ["international +44 20 7946 0958 ring", "+44 20 7946 0958", "[phone redacted]"],
    ["berlin 49-30-12345678 wired", "49-30-12345678", "[phone redacted]"],
    ["paris 33-1-23-45-67-89 ring", "33-1-23-45-67-89", "[phone redacted]"],
    ["plus-no-sep +14155550199 fast", "+14155550199", "[phone redacted]"],
  ];
  for (const [input, secret, label] of cases) {
    const out = scrubString(input);
    assert.ok(!out.includes(secret), `leaked PII: ${secret} -> ${out}`);
    assert.ok(out.includes(label), `expected ${label} in: ${out}`);
  }
});

test("preserves short digit groups and code-like prose", () => {
  const keep = [
    "run `npm test` in ./src and check exit code 1",
    "port 9119 is listening",
    "session id 20260711_120841_61db2f",
    "seq 761 received",
  ];
  for (const s of keep) assert.equal(scrubString(s), s);
});

test("scrubs names and tasks in subagent metadata", () => {
  const out = redactEvent(ev("subagent.meta", {
    agents: [{
      name: "ada.lovelace@example.com",
      task: `rotate ${fakeOpenAiKey} on 10.0.42.7`,
      elapsed_s: 12,
      status: "running",
    }],
  }));
  const rendered = JSON.stringify(out);
  assert.ok(!rendered.includes("ada.lovelace@example.com"));
  assert.ok(!rendered.includes(fakeOpenAiKey));
  assert.ok(!rendered.includes("10.0.42.7"));
});
