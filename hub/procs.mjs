// Process lookups Windows doesn't give Node directly.
import { execFile } from "node:child_process";

const POWERSHELL = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe";

/**
 * The parent of a process, or null. Used once per view-only session: the hook
 * script runs under PowerShell, whose parent is Claude Code, and the hub wants
 * Claude's pid to notice when it exits. About 400 ms, so never on a hot path.
 */
export function parentPid(pid) {
  if (!pid || process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
      (err, stdout) => {
        const n = Number(String(stdout || "").trim());
        resolve(!err && n > 0 ? n : null);
      },
    );
  });
}
