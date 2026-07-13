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
    // Ask the root Electron window to close first. Hermes handles window close
    // with app.quit(), which flushes its logs/state and stops its backend child.
    // Force is a last-resort fallback only; killing Electron first can leave its
    // single-instance/runtime state unhealthy for the next ordinary launch.
    const script = [
      "$target = [IO.Path]::GetFullPath($env:SPECTATOR_HERMES_DESKTOP)",
      "$findDesktop = { @(Get-CimInstance Win32_Process | Where-Object {",
      "  $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target)",
      "}) }",
      "$all = & $findDesktop",
      "$roots = @($all | Where-Object { $_.CommandLine -notmatch '--type=' })",
      "$roots | ForEach-Object {",
      "  $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue",
      "  if ($process) { [void]$process.CloseMainWindow() }",
      "}",
      "$deadline = [DateTime]::UtcNow.AddSeconds(8)",
      "while ((& $findDesktop).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }",
      "$remainingRoots = @((& $findDesktop) | Where-Object { $_.CommandLine -notmatch '--type=' })",
      "$remainingRoots | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T 2>$null | Out-Null }",
      "if ($remainingRoots.Count -gt 0) { Start-Sleep -Seconds 2 }",
      "$all = & $findDesktop",
      "$ids = [Collections.Generic.HashSet[int]]::new()",
      "$all | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }",
      "$processes = @(Get-CimInstance Win32_Process)",
      "do {",
      "  $before = $ids.Count",
      "  $processes | Where-Object { $ids.Contains([int]$_.ParentProcessId) } | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }",
      "} while ($ids.Count -gt $before)",
      "$processes | Where-Object { $ids.Contains([int]$_.ProcessId) } | Sort-Object ProcessId -Descending | ForEach-Object {",
      "  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue",
      "}",
    ].join("\n");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, SPECTATOR_HERMES_DESKTOP: this.executable },
      stdio: "ignore",
    });
    await wait(300);
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
    // Electron can outlive its visible process briefly while releasing the
    // single-instance lock. An immediate relaunch may hand off to that dying
    // instance and exit without ever creating a window.
    await wait(1500);
    this.launch(false);
  }
}
