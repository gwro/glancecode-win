import { test } from "node:test";
import assert from "node:assert/strict";
import { startHost } from "../host/host.mjs";
import { HostClient, KEYS, attach, resolveClaude } from "../host/client.mjs";

const WIN = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pipe = `\\\\.\\pipe\\glancecode-test-${process.pid}-${Date.now()}`;

/** Poll until the screen contains `text` or time runs out. */
async function screenHas(c, session, text, ms = 5000) {
  const until = Date.now() + ms;
  let last = "";
  while (Date.now() < until) {
    last = (await c.request("screen", { session, lines: 50 })).text;
    if (last.includes(text)) return last;
    await sleep(100);
  }
  throw new Error(`screen never showed ${JSON.stringify(text)}; last:\n${last}`);
}

test("host runs a console program, types into it, reads the screen and sees it end", { skip: !WIN && "Windows only" }, async () => {
  const host = startHost({ pipe, exitWhenIdle: false });
  await new Promise((r) => host.server.on("listening", r));
  const c = new HostClient(pipe);
  try {
    assert.equal((await c.request("ping")).sessions, 0);
    const s = await c.request("new", { name: "my project!", cwd: process.cwd(), cmd: process.env.ComSpec, args: ["/d", "/q", "/k"], cols: 80, rows: 24 });
    assert.equal(s.name, "my-project-");
    await screenHas(c, s.id, ">"); // the prompt
    await c.request("write", { session: s.id, data: "echo typed by the host" });
    await c.request("key", { session: s.id, key: "Enter" });
    const screen = await screenHas(c, s.id, "\ntyped by the host");
    assert.match(screen, /echo typed by the host/);
    const list = (await c.request("list")).sessions;
    assert.equal(list.length, 1);
    assert.ok(list[0].pid > 0, "the host knows the process id");
    assert.equal((await c.request("alive", { session: s.id })).alive, true);
    // Names are unique per host.
    const s2 = await c.request("new", { name: "my project!", cwd: process.cwd(), cmd: process.env.ComSpec, args: ["/d", "/q", "/k"] });
    assert.equal(s2.name, "my-project--2");
    await c.request("kill", { session: s2.id });
    await c.request("write", { session: s.id, data: "exit\r" });
    const until = Date.now() + 8000;
    while (Date.now() < until && (await c.request("alive", { session: s.id })).alive) await sleep(200);
    assert.equal((await c.request("alive", { session: s.id })).alive, false);
    await assert.rejects(c.request("screen", { session: s.id }), /no session/);
    await assert.rejects(c.request("key", { session: s2.id, key: "F1" }), /no session|not allowed/);
  } finally {
    c.close();
    for (const s of host.sessions.values()) s.kill();
    host.close();
  }
});

test("attach paints the current screen and relays input", { skip: !WIN && "Windows only" }, async () => {
  const p = `${pipe}-attach`;
  const host = startHost({ pipe: p, exitWhenIdle: false });
  await new Promise((r) => host.server.on("listening", r));
  const c = new HostClient(p);
  try {
    const s = await c.request("new", { name: "a", cwd: process.cwd(), cmd: process.env.ComSpec, args: ["/d", "/q", "/k"], cols: 80, rows: 24 });
    await screenHas(c, s.id, ">");
    const { PassThrough } = await import("node:stream");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.columns = 100;
    stdout.rows = 30;
    let out = "";
    stdout.on("data", (d) => (out += d.toString("utf8")));
    const done = attach({ pipe: p, id: s.id, stdin, stdout });
    await sleep(500);
    assert.match(out, />/, "the existing prompt is painted on attach");
    assert.equal(host.sessions.get(s.id).cols, 100, "the pane takes the client's size");
    stdin.write("echo via attach\r");
    await screenHas(c, s.id, "\nvia attach");
    stdin.write(Buffer.from([0x1d])); // Ctrl+]
    const result = await done;
    assert.equal(result.reason, "detached");
    assert.equal((await c.request("alive", { session: s.id })).alive, true, "detaching leaves the session running");
  } finally {
    c.close();
    for (const s of host.sessions.values()) s.kill();
    host.close();
  }
});

test("the detach chord is recognised in every encoding a Windows terminal uses", async () => {
  const { isDetachChord } = await import("../host/client.mjs");
  assert.equal(isDetachChord(Buffer.from([0x1d])), true, "plain byte");
  // Windows Terminal in win32-input-mode: Ctrl down, Ctrl+] down and up, Ctrl up.
  assert.equal(isDetachChord(Buffer.from("\x1b[17;29;0;1;8;1_\x1b[221;27;29;1;8;1_\x1b[221;27;29;0;8;1_\x1b[17;29;0;0;0;1_", "latin1")), true);
  assert.equal(isDetachChord(Buffer.from("\x1b[221;27;29;0;8;1_", "latin1")), false, "key up alone");
  assert.equal(isDetachChord(Buffer.from("\x1b[93;5u", "latin1")), true, "kitty protocol");
  assert.equal(isDetachChord(Buffer.from("\x1b[72;35;104;1;0;1_", "latin1")), false, "a plain h");
  assert.equal(isDetachChord(Buffer.from("hello")), false);
});

test("key table covers what the hub may press", () => {
  for (const k of ["Enter", "Escape", "Up", "Down", "Tab", "BTab", "1", "9"]) assert.ok(KEYS[k], k);
  assert.equal(KEYS.Enter, "\r");
});

test("resolveClaude prefers an executable and unwraps the npm shim", { skip: !WIN && "Windows only" }, () => {
  const r = resolveClaude("claude");
  if (!r) return; // Claude Code not installed on this machine
  assert.ok(/\.exe$/i.test(r.cmd) || /cmd\.exe$/i.test(r.cmd), r.cmd);
});
