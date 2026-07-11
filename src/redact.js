// Redaction layer. Every event passes through here before fan-out.
// This module is why the public link is safe. Fail closed: when unsure, hide.
import os from "node:os";

const HOME = os.homedir();

// Event kinds that must never leave the machine at all.
export const DROP_KINDS = new Set(["sudo.request", "secret.request"]);

const PATTERNS = [
  // Provider key shapes
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,             // OpenAI / Anthropic style
  /\bghp_[A-Za-z0-9]{20,}\b/g,              // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abps]-[A-Za-z0-9-]{10,}\b/g,       // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                  // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // .env style lines: KEY=value where KEY smells secret
  /^([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+/gim,
  // long high-entropy blobs (base64/hex, 40+ chars, no spaces)
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
];

export function scrubString(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, (m, key) =>
    key ? `${key}=[redacted]` : "[redacted]");
  if (HOME && HOME !== "/") out = out.split(HOME).join("~");
  return out;
}

function scrubDeep(v) {
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = scrubDeep(val);
    return out;
  }
  return v;
}

/**
 * @param {import("./schema.js").WireEvent} ev
 * @param {{ fullToolOutput?: boolean }} opts
 * @returns {WireEvent|null} null = drop entirely
 */
export function redactEvent(ev, opts = {}) {
  if (DROP_KINDS.has(ev.kind)) return null;
  const out = { ...ev, payload: scrubDeep(ev.payload) };
  // Tool detail policy: names + summaries only, unless the host opted in.
  if (!opts.fullToolOutput) {
    if (ev.kind === "tool.start" && out.payload.args !== undefined) {
      out.payload = { ...out.payload, args: undefined, argsHidden: true };
    }
    if (ev.kind === "tool.progress" && typeof out.payload.chunk === "string" && out.payload.chunk.length > 400) {
      out.payload = { ...out.payload, chunk: out.payload.chunk.slice(0, 400) + " … [truncated]" };
    }
    if (ev.kind === "tool.complete" && out.payload.output !== undefined) {
      out.payload = { ...out.payload, output: undefined, outputHidden: true };
    }
  }
  return out;
}
