import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("viewer is self-contained and does not request third-party assets", () => {
  assert.ok(!/<(?:script|link|img)\b[^>]+(?:src|href)=["']https?:/i.test(html));
  assert.ok(html.includes("spectator"));
  for (const token of ["#1e1e2e", "#181825", "#11111b", "#313244", "#45475a", "#cdd6f4", "#cba6f7", "#89b4fa", "#a6e3a1", "#f9e2af", "#f38ba8"]) {
    assert.ok(html.toLowerCase().includes(token), `missing Catppuccin token ${token}`);
  }
  assert.match(html, /JetBrains Mono/);
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

test("viewer has no embedded third-party iframe or remote script", () => {
  assert.ok(!/<iframe\b/i.test(html), "viewer must not embed an iframe");
  assert.ok(!/<iframe\b[^>]+src=["']https?:/i.test(html), "viewer must not load a remote iframe");
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html), "viewer must not load remote scripts");
  assert.ok(!/<link\b[^>]+href=["']https?:/i.test(html), "viewer must not load remote stylesheets");
});

test("viewer renders first-party retro tool telemetry and uses its scroll container", () => {
  for (const token of ["tool-telemetry", "toolSummary", "telemetry-card", "updateToolSummary", "host redacts secrets and PII"]) {
    assert.ok(html.includes(token), `missing retro telemetry element ${token}`);
  }
  assert.ok(html.includes('document.querySelector(".main-inner")'));
  assert.ok(html.includes('scroller.addEventListener("scroll"'));
  assert.ok(!/twitch/i.test(html), "viewer must not retain Twitch-specific UI or runtime code");
});

test("viewer has structured stream chrome and suppresses control and tool payload transcript noise", () => {
  for (const token of ["stream-head", "ensureStreamHead", "stream-head-status", "transcriptKind", "session instruction hidden", "tool payload summarized in tool cards", "turn.suppressed"]) {
    assert.ok(html.includes(token), `missing structured stream renderer wiring: ${token}`);
  }
  assert.ok(html.includes('"session.meta"'));
  assert.ok(html.includes('"user.message"'));
  assert.ok(html.includes('"message.complete"'));
  assert.ok(html.includes('"tool.start"'));
  assert.ok(html.includes('"status"'));
});

test("viewer renders safe Markdown for chat messages", () => {
  for (const token of ["const markdown =", "fmtInline", "markdown-code", "tableCells", "tableDivider", "<table>", "<h${level}>", "<blockquote>", "target=\"_blank\""]) {
    assert.ok(html.includes(token), `missing Markdown renderer token ${token}`);
  }
  assert.ok(html.includes("Never inject raw message content into HTML"));
  assert.ok(html.includes("rec.el.innerHTML = markdown(rec.text)"));
});

test("viewer has a left stream-health panel and conversation-first tool grouping", () => {
  for (const token of ["health-panel", "healthSource", "healthLastEvent", "healthDropped", "ingest-only watcher", "class=\"activity\"", "ensureActivityTurn", "conversation.activity.appendChild(card)"]) {
    assert.ok(html.includes(token), `missing stream health or conversation grouping token ${token}`);
  }
  assert.ok(html.includes("border-right: 1px solid var(--border)"));
  assert.ok(html.includes("order: -1"));
});

test("viewer replaces sidebar tool-call telemetry with the read-only Kanban tracker", () => {
  for (const token of ["/kanban", "kanbanTracker", "renderKanban", "working on", "kanban-row", "code-tasks"]) {
    assert.ok(html.includes(token), `missing Kanban viewer token ${token}`);
  }
  assert.ok(html.includes('task.status !== "done"'));
  assert.ok(html.includes('task.status !== "archived"'));
});
test("viewer supports Twitch OBS mode, task announcements, and dependency route", () => {
  for (const token of ["viewMode", "obs-mode", "task-announcement", "announceTaskChange", "current work route", "renderRoute", "/kanban"]) {
    assert.ok(html.includes(token), `missing broadcast feature token ${token}`);
  }
});

test("viewer renders a persistent, desktop-only subagent tracker from relay metadata", () => {
  for (const token of ["subagentTracker", "subagentRows", "subagentDismiss", "spectator-subagent-hidden", '"subagent.meta"', "subagent-row"]) {
    assert.ok(html.includes(token), `missing subagent tracker token ${token}`);
  }
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.subagent-tracker \{ display: none; \}/);
});
