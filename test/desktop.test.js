import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { desktopEnvironment } from "../src/desktop.js";

test("desktop environment removes temporary remote mode when restoring Hermes", () => {
  const base = {
    KEEP_ME: "yes",
    HERMES_DESKTOP_REMOTE_URL: "http://127.0.0.1:9121",
    HERMES_DESKTOP_REMOTE_TOKEN: "temporary-token",
  };
  assert.deepEqual(desktopEnvironment(base), { KEEP_ME: "yes" });
  assert.deepEqual(desktopEnvironment(base, "http://127.0.0.1:9121", "new-token"), {
    KEEP_ME: "yes",
    HERMES_DESKTOP_REMOTE_URL: "http://127.0.0.1:9121",
    HERMES_DESKTOP_REMOTE_TOKEN: "new-token",
  });
  assert.equal(base.HERMES_DESKTOP_REMOTE_TOKEN, "temporary-token");
});

test("managed teardown closes Hermes gracefully before any forced fallback", () => {
  const manager = fs.readFileSync(new URL("../src/desktop.js", import.meta.url), "utf8");
  const stopScript = fs.readFileSync(new URL("../scripts/stop-spectator.ps1", import.meta.url), "utf8");
  assert.ok(manager.indexOf("CloseMainWindow") < manager.indexOf("Stop-Process -Id $_.ProcessId -Force"));
  assert.ok(stopScript.indexOf("--close-desktop") < stopScript.indexOf("Stop-Process -Id $process.ProcessId -Force"));
});

test("operator startup discovers a per-run token and never reads Hermes's env file", () => {
  const startScript = fs.readFileSync(new URL("../scripts/start-spectator.ps1", import.meta.url), "utf8");
  assert.ok(startScript.includes("window\\.__HERMES_SESSION_TOKEN__"));
  assert.ok(startScript.includes("Start-Process node.exe"));
  assert.ok(startScript.includes("-PassThru -Wait"));
  assert.ok(!startScript.includes("Get-Content $envFile"));
  assert.ok(!startScript.includes("Pin it in ~/.hermes/.env"));
});
