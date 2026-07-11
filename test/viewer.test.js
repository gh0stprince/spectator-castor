import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("viewer is self-contained and does not request third-party assets", () => {
  assert.ok(!/<(?:script|link|img)\b[^>]+(?:src|href)=["']https?:/i.test(html));
  assert.ok(html.includes("SPECTATOR"));
});

test("viewer supports persistent accessible light and dark themes", () => {
  assert.ok(html.includes(':root[data-theme="light"]'));
  assert.ok(html.includes('localStorage.getItem("spectator-theme")'));
  assert.ok(html.includes('localStorage.setItem("spectator-theme", next)'));
  assert.ok(html.includes('aria-label", `Use ${next} theme`'));
  assert.ok(html.includes('prefers-color-scheme: light'));
});

test("viewer scopes messages and activity to Hermes sessions", () => {
  assert.ok(html.includes('`${ev.sessionId || "live"}:${id}`'));
  assert.ok(html.includes("entityKey(ev, ev.payload.messageId)"));
  assert.ok(html.includes("entityKey(ev, ev.payload.toolId)"));
  assert.ok(html.includes("entityKey(ev, ev.payload.approvalId)"));
});
