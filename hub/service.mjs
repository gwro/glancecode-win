// The hub as a background service on Windows: a Task Scheduler task that starts at
// logon, runs hidden, and is restarted when it fails. Also the file logger the hub
// uses in that mode, since a hidden process has nowhere else to write.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRAND } from "./brand.mjs";

const SYSTEM32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
const SCHTASKS = join(SYSTEM32, "schtasks.exe");
const WSCRIPT = join(SYSTEM32, "wscript.exe");
const POWERSHELL = join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");
export const TASK_NAME = BRAND.serviceLabel;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const vbsQuote = (s) => `""${String(s).replace(/"/g, '""')}""`; // a quoted argument inside a VBS string literal

/** DOMAIN\user for the signed-in user, as Task Scheduler wants it. */
export function currentUser() {
  const domain = process.env.USERDOMAIN || process.env.COMPUTERNAME || ".";
  return `${domain}\\${process.env.USERNAME || "user"}`;
}

/**
 * A console program started by a logon task gets a console window. wscript.exe is
 * a GUI program, so a three-line script that starts the hub hidden and waits for
 * it, passing its exit code on, keeps Task Scheduler in charge without a window.
 */
export function hubLauncherScript({ nodePath, cliPath }) {
  return `Set sh = CreateObject("WScript.Shell")\r\nWScript.Quit sh.Run("${vbsQuote(nodePath)} ${vbsQuote(cliPath)} hub --service", 0, True)\r\n`;
}

/** Same trick for the session host, without waiting: the host outlives its starter. */
export function hostLauncherScript({ nodePath, hostPath, pipe, logFile }) {
  return `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${vbsQuote(nodePath)} ${vbsQuote(hostPath)} --pipe ${vbsQuote(pipe)} --log ${vbsQuote(logFile)}", 0, False\r\n`;
}

export function taskXml({ launcher, user }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(BRAND.displayName)} hub: follows Claude Code sessions for the glasses. Managed by \`${xmlEscape(BRAND.name)} service\`.</Description>
    <URI>\\${xmlEscape(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(WSCRIPT)}</Command>
      <Arguments>"${xmlEscape(launcher)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function schtasks(args) {
  return spawnSync(SCHTASKS, args, { encoding: "utf8", windowsHide: true });
}

/**
 * Register (or replace) the task and start it now.
 * @returns {{launcher: string, xml: string}}
 */
export function installService({ nodePath, cliPath, dataDir }) {
  mkdirSync(dataDir, { recursive: true });
  const launcher = join(dataDir, "hub-launcher.vbs");
  writeFileSync(launcher, hubLauncherScript({ nodePath, cliPath }));
  const xmlPath = join(dataDir, "hub-task.xml");
  const xml = taskXml({ launcher, user: currentUser() });
  // schtasks reads the XML in the encoding it declares; UTF-16 LE with a BOM is the safe form.
  writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  stopService({ quiet: true });
  const r = schtasks(["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
  if (r.status !== 0) throw new Error(`schtasks /Create failed: ${(r.stderr || r.stdout || "").trim()}`);
  const run = schtasks(["/Run", "/TN", TASK_NAME]);
  if (run.status !== 0) throw new Error(`schtasks /Run failed: ${(run.stderr || run.stdout || "").trim()}`);
  return { launcher, xml: xmlPath };
}

/** End the task (so Task Scheduler doesn't restart it) and stop the hub process it started. */
export function stopService({ quiet = false } = {}) {
  const ended = schtasks(["/End", "/TN", TASK_NAME]);
  const killed = killHubProcesses();
  if (!quiet && ended.status !== 0 && !killed) return false;
  return true;
}

export function startService() {
  const r = schtasks(["/Run", "/TN", TASK_NAME]);
  if (r.status !== 0) throw new Error(`schtasks /Run failed: ${(r.stderr || r.stdout || "").trim()}`);
}

export function uninstallService() {
  stopService({ quiet: true });
  const r = schtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
  return r.status === 0;
}

/**
 * Hub processes started by the service (`hub --service` on their command line).
 * Ending the task stops its launcher; the hub itself is a separate process.
 */
function killHubProcesses() {
  const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${BRAND.name}* hub --service*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
  const r = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  return (r.stdout || "").trim().length > 0;
}

/**
 * @returns {{installed: boolean, state?: string, lastRun?: string, lastResult?: number, nextRun?: string}}
 */
export function serviceStatus() {
  const script = `$t = Get-ScheduledTask -TaskName '${TASK_NAME.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; if (-not $t) { '{"installed":false}' } else { $i = $t | Get-ScheduledTaskInfo; @{ installed = $true; state = [string]$t.State; lastRun = [string]$i.LastRunTime; lastResult = $i.LastTaskResult; nextRun = [string]$i.NextRunTime } | ConvertTo-Json -Compress }`;
  try {
    const out = execFileSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    return JSON.parse(out.trim() || '{"installed":false}');
  } catch {
    return { installed: false };
  }
}

/**
 * Send console output to a file, rotating once at `LOG_ROTATE_BYTES`. For the
 * hidden service process; a foreground hub keeps writing to the terminal.
 */
export function installFileLogger(file) {
  mkdirSync(dirname(file), { recursive: true });
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ${args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(" ")}\n`;
    try {
      if (existsSync(file) && statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, line);
    } catch {
      /* nowhere to log */
    }
  };
  console.log = (...a) => write("info", a);
  console.warn = (...a) => write("warn", a);
  console.error = (...a) => write("error", a);
  process.on("uncaughtException", (err) => write("fatal", [err]));
  process.on("unhandledRejection", (err) => write("fatal", [err instanceof Error ? err : new Error(String(err))]));
  return file;
}
