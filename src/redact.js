// Redaction layer. Every event passes through here before fan-out.
// This module is why the public link is safe. Fail closed: when unsure, hide.
import os from "node:os";

const HOME = os.homedir();

// Event kinds that must never leave the machine at all.
export const DROP_KINDS = new Set(["sudo.request", "secret.request"]);

// User-specified PII patterns. Each entry is [regex, label]. Named groups are
// preserved in the replacement so the viewer still shows *what kind* of PII
// was scrubbed (e.g. "email [redacted]"), never the value itself. Patterns
// are applied in order — SSN before phone so dashes don't get swallowed.
const PII_PATTERNS = [
  // US SSN (3-2-4 with dashes): must precede phone so the dash pattern wins.
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn redacted]"],
  // Email addresses (RFC 5322 lite).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email redacted]"],
  // North American 10/11-digit numbers: optional `+1` country code, NPA must
  // start with 2-9. Matches run-together, spaced, parenthesized NPA, and bare
  // 10-digit forms. The NPA guard prevents collisions with ports, sequence
  // numbers, and hex-like ids.
  [/(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?([2-9]\d{2})[-.\s]?(\d{4})\b/g, "[phone redacted]"],
  // E.164 international numbers: `+` followed by 8-15 digits, with optional
  // grouping separators. Rejects bare digit groups with no `+` prefix to
  // avoid collisions with ids.
  [/\+\d(?:[-.\s]\d|\d){7,14}\b/g, "[phone redacted]"],
  // National-format international numbers: country code from a common
  // list, then a 4-15 digit subscriber, optionally grouped. Anchored so
  // prose like "49 days" or "rule 49" never matches.
  [/\b(?:49|44|33|81|82|61|62|91|86|353|354|46|47|48|31|32|41|43|45)[-.\s]\d(?:[-.\s]?\d){3,14}\b/g, "[phone redacted]"],
  // IPv4 addresses (each octet 0-255).
  [/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, "[ipv4 redacted]"],
  // MAC addresses (xx:xx:xx:xx:xx:xx or xx-xx-xx-xx-xx-xx).
  [/\b(?:[0-9A-Fa-f]{2}[:]){5}[0-9A-Fa-f]{2}\b/g, "[mac redacted]"],
  // Credit-card-like 13-19 digit groups.
  [/\b(?:\d[ -]?){13,19}\b/g, "[card redacted]"],
];

const PATTERNS = [
  // Provider key shapes
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,             // OpenAI / Anthropic style
  /\bghp_[A-Za-z0-9]{20,}\b/g,              // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abps]-[A-Za-z0-9-]{10,}\b/g,       // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                  // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // long high-entropy blobs (base64/hex, 40+ chars, no spaces)
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
];

// Kept separate because this is the only pattern with a capture group that
// should be preserved in the replacement. For capture-free patterns, the
// second replace-callback argument is the match offset, not a captured value.
const ENV_SECRET_PATTERN = /^([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+/gim;

export function scrubString(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, "[redacted]");
  out = out.replace(ENV_SECRET_PATTERN, (_match, key) => `${key}=[redacted]`);
  for (const [re, label] of PII_PATTERNS) out = out.replace(re, label);
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
