// Keep the PC awake while the hub runs, so the glasses never see a sleeping hub.
// Windows' SetThreadExecutionState holds the system (not the display) awake for as
// long as the calling thread keeps asking, so a small PowerShell helper asks every
// half minute, only while on AC power, and leaves when the hub is gone.
import { spawn } from "node:child_process";
import { join } from "node:path";

const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** The helper's script. `hubPid` is who it works for; it exits when that process ends. */
export function keepAwakeScript(hubPid) {
  return `
Add-Type -Namespace Glance -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
Add-Type -AssemblyName System.Windows.Forms
$continuous = [uint32]0x80000000
$systemRequired = [uint32]0x00000001
$held = $false
while ($true) {
  if (-not (Get-Process -Id ${Number(hubPid)} -ErrorAction SilentlyContinue)) { break }
  $onAc = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -ne 'Offline'
  if ($onAc) { [void][Glance.Power]::SetThreadExecutionState($continuous -bor $systemRequired); $held = $true }
  elseif ($held) { [void][Glance.Power]::SetThreadExecutionState($continuous); $held = $false }
  Start-Sleep -Seconds 30
}
[void][Glance.Power]::SetThreadExecutionState($continuous)
`;
}

/**
 * Start the helper. Returns something with kill(), or null off Windows.
 */
export function startKeepAwake({ hubPid = process.pid, log = () => {} } = {}) {
  if (process.platform !== "win32") return null;
  const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", keepAwakeScript(hubPid)], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.on("exit", (code) => {
    if (code) log(`keep-awake helper exited (${code}): ${stderr.trim().split("\n")[0] || ""}`);
  });
  child.on("error", (err) => log(`could not start the keep-awake helper: ${err.message}`));
  return child;
}
