// Plays the bundled fixture through the relay as if a live agent were working.
// Loops forever so a shared demo link always has something on screen.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkEvent, AGENT } from "./schema.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "demo-session.jsonl");
const HUMAN = { type: "human", id: "demo-user", name: "Mustafa", color: "#7AA2F7" };

export function startDemo(relay, { loop = true } = {}) {
  const steps = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      for (const step of steps) {
        if (stopped) return;
        await new Promise((r) => setTimeout(r, step.delay));
        const actor = step.actor === "human" ? HUMAN : AGENT("hermes");
        relay.ingest(mkEvent("live", actor, step.kind, step.payload));
      }
      if (!loop) return;
      await new Promise((r) => setTimeout(r, 4000));
      relay.ingest(mkEvent("live", AGENT("hermes"), "status", { state: "idle", detail: "demo loops in a moment" }));
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  run();
  return () => { stopped = true; };
}
