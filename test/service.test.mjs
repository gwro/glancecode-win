import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostLauncherScript, hubLauncherScript, installFileLogger, taskXml } from "../hub/service.mjs";

test("launcher scripts quote paths with spaces for VBScript", () => {
  const hub = hubLauncherScript({ nodePath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "D:\\my repos\\glancecode\\bin\\glancecode" });
  assert.match(hub, /WScript\.Quit sh\.Run\("""C:\\Program Files\\nodejs\\node\.exe"" ""D:\\my repos\\glancecode\\bin\\glancecode"" hub --service", 0, True\)/);
  const host = hostLauncherScript({ nodePath: "C:\\n\\node.exe", hostPath: "D:\\g\\host\\host.mjs", pipe: "\\\\.\\pipe\\glancecode-host-me", logFile: "C:\\l\\host.log" });
  assert.match(host, /--pipe ""\\\\\.\\pipe\\glancecode-host-me"" --log ""C:\\l\\host\.log""", 0, False/);
});

test("task XML names the user, runs hidden through wscript, and restarts on failure", () => {
  const xml = taskXml({ launcher: "C:\\Users\\Me\\AppData\\Local\\glancecode\\hub-launcher.vbs", user: "PC\\Me" });
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>PC\\Me<\/UserId>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Command>[^<]*wscript\.exe<\/Command>\s*<Arguments>"C:\\Users\\Me\\AppData\\Local\\glancecode\\hub-launcher\.vbs"<\/Arguments>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
});

test("file logger writes timestamped lines and keeps errors' stacks", () => {
  const dir = mkdtempSync(join(tmpdir(), "glancecode-log-"));
  const file = join(dir, "hub.log");
  const original = { log: console.log, warn: console.warn, error: console.error };
  try {
    installFileLogger(file);
    console.log("hub on", 7717);
    console.error(new Error("boom"));
  } finally {
    Object.assign(console, original);
  }
  const text = readFileSync(file, "utf8");
  assert.match(text, /^\d{4}-\d\d-\d\dT[^ ]+ info hub on 7717\n/m);
  assert.match(text, /error Error: boom\n\s+at /);
});
