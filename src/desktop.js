// Optional Hermes Desktop lifecycle management.
// Keeps the temporary Spectator remote-mode environment process-local and
// restores a normal standalone Desktop when Spectator exits.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function desktopEnvironment(base, remoteUrl = null, token = null) {
  const env = { ...base };
  delete env.HERMES_DESKTOP_REMOTE_URL;
  delete env.HERMES_DESKTOP_REMOTE_TOKEN;
  if (remoteUrl) env.HERMES_DESKTOP_REMOTE_URL = remoteUrl;
  if (token) env.HERMES_DESKTOP_REMOTE_TOKEN = token;
  return env;
}

export function defaultDesktopPath(env = process.env) {
  if (process.platform !== "win32" || !env.LOCALAPPDATA) return null;
  return path.join(
    env.LOCALAPPDATA,
    "hermes", "hermes-agent", "apps", "desktop", "release", "win-unpacked", "Hermes.exe",
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

export class HermesDesktopManager {
  constructor({ executable = defaultDesktopPath(), remoteUrl, token }) {
    if (process.platform !== "win32") throw new Error("managed Hermes Desktop is currently supported on Windows only");
    if (!executable || !fs.existsSync(executable)) throw new Error(`Hermes Desktop executable not found: ${executable ?? "(unknown)"}`);
    this.executable = path.resolve(executable);
    this.remoteUrl = remoteUrl;
    this.token = token;
  }

  async stop() {
    // Match the exact executable path so the Python hermes dashboard/backend is
    // never touched. Electron helper processes share this path and must all go.
    const script = [
      "$target = [IO.Path]::GetFullPath($env:SPECTATOR_HERMES_DESKTOP)",
      "$all = @(Get-CimInstance Win32_Process)",
      "$ids = [Collections.Generic.HashSet[int]]::new()",
      "$all | Where-Object {",
      "  $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target)",
      "} | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }",
      "do {",
      "  $before = $ids.Count",
      "  $all | Where-Object { $ids.Contains([int]$_.ParentProcessId) } | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }",
      "} while ($ids.Count -gt $before)",
      "$all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Sort-Object ProcessId -Descending | ForEach-Object {",
      "  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue",
      "}",
    ].join("\n");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, SPECTATOR_HERMES_DESKTOP: this.executable },
      stdio: "ignore",
    });
    await wait(700);
  }

  launch(remote = false) {
    const env = desktopEnvironment(process.env, remote ? this.remoteUrl : null, remote ? this.token : null);
    const child = spawn(this.executable, [], { detached: true, stdio: "ignore", env, windowsHide: false });
    child.unref();
  }

  async startManaged() {
    await this.stop();
    this.launch(true);
  }

  async restoreNormal() {
    await this.stop();
    this.launch(false);
  }
}
