param(
  [int]$HermesPort = 9119,
  [int]$TapPort = 9121,
  [int]$ViewerPort = 8787,
  [string]$ViewKey = $env:SPECTATOR_VIEW_KEY,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

try {
  $status = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$HermesPort/api/status"
  if ($status.StatusCode -ne 200) { throw "status $($status.StatusCode)" }
} catch {
  throw "Hermes is not ready on 127.0.0.1:$HermesPort. First run: hermes dashboard --no-open"
}

# A global token in Hermes's .env overrides the fresh token Desktop passes to
# its own local backend and breaks the next ordinary Desktop launch. Never read
# or write that file here. A dashboard safely injects its current token into its
# loopback-only HTML, so discover it per run unless the operator scoped one to
# this shell explicitly.
if (-not $env:HERMES_DASHBOARD_SESSION_TOKEN) {
  try {
    $dashboard = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$HermesPort/"
    $match = [regex]::Match($dashboard.Content, 'window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")')
    if (-not $match.Success) { throw "dashboard token was not present in the served page" }
    $env:HERMES_DASHBOARD_SESSION_TOKEN = $match.Groups[1].Value | ConvertFrom-Json
  } catch {
    throw "Could not discover the dashboard session token. Run 'hermes dashboard --no-open' (not 'hermes serve') and try again. Do not pin HERMES_DASHBOARD_SESSION_TOKEN in Hermes's .env."
  }
}

Write-Host "Starting Spectator. Keep this window open; press Ctrl+C for a clean shutdown." -ForegroundColor Yellow
$cliArgs = @(
  "src/cli.js",
  "--hermes-url", "http://127.0.0.1:$HermesPort",
  "--port", "$ViewerPort",
  "--tap-port", "$TapPort",
  "--manage-desktop",
  "--persist", ".spectator/session-events.jsonl"
)
if ($ViewKey) { $cliArgs += @("--view-key", $ViewKey) }
if ($ExtraArgs) { $cliArgs += $ExtraArgs }
$spectator = Start-Process node.exe -ArgumentList $cliArgs -NoNewWindow -PassThru -Wait

if ($spectator.ExitCode -ne 0) {
  Write-Warning "Spectator exited unexpectedly. Closing its managed Hermes Desktop safely."
  $cleanup = Start-Process node.exe -ArgumentList @("src/cli.js", "--close-desktop") -NoNewWindow -PassThru -Wait
  exit $spectator.ExitCode
}
