import { test } from "node:test";
import assert from "node:assert/strict";
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
