// agent-wire event schema (v0)
// Every event that reaches a browser has this shape. Nothing else is ever forwarded.

/**
 * @typedef {{ type: "agent"|"human", id: string, name: string, color?: string }} Actor
 *
 * @typedef {Object} WireEvent
 * @property {string} id        uuid
 * @property {number} ts        epoch ms
 * @property {string} sessionId
 * @property {number} seq       monotonic per session, assigned by the relay
 * @property {Actor}  actor
 * @property {string} kind      see KINDS
 * @property {Object} payload
 */

export const KINDS = new Set([
  "message.delta",      // { messageId, text }
  "message.complete",   // { messageId, text }
  "user.message",       // { text }                        (what the human asked)
  "tool.start",         // { toolId, name, summary }
  "tool.progress",      // { toolId, chunk }
  "tool.complete",      // { toolId, status: "ok"|"error", summary }
  "approval.request",   // { approvalId, name, summary }
  "approval.decision",  // { approvalId, decision }
  "clarify.request",    // { text }
  "presence.state",     // { viewers }
  "session.meta",       // { title, model, startedAt }
  "status",             // { state: "thinking"|"tooling"|"idle"|"waiting"|"connecting"|"reconnecting"|"live"|"ended", detail? }
]);

let counter = 0;
export function mkEvent(sessionId, actor, kind, payload = {}) {
  if (!KINDS.has(kind)) throw new Error(`unknown event kind: ${kind}`);
  return {
    id: `${Date.now().toString(36)}-${(counter++).toString(36)}`,
    ts: Date.now(),
    sessionId,
    seq: -1, // relay assigns
    actor,
    kind,
    payload,
  };
}

export const AGENT = (name = "hermes") => ({ type: "agent", id: "agent", name });
export const SYSTEM = { type: "agent", id: "system", name: "hermes-live" };
