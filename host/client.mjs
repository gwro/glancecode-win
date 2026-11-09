// Client side of the session host: connect to its named pipe, start it when it
// isn't running, and relay a console to a session (the `tmux attach` of this port).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOST_SCRIPT = join(HERE, "host.mjs");

/** The one host per Windows user listens here. */
export function defaultPipe() {
  const user = (userInfo().username || "user").replace(/[^A-Za-z0-9_-]/g, "_");
  return `\\\\.\\pipe\\glancecode-host-${user}`;
}

/** Keys the hub may press, and the bytes a terminal would send for them. */
export const KEYS = {
  Enter: "\r",
  // A lone ESC through the ConPTY input pipe waits out conhost's escape-sequence
  // timeout; as a win32-input-mode key record (VK_ESCAPE down, up) it is immediate.
  Escape: "\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_",
  Tab: "\t",
  BTab: "\x1b[Z",
  Up: "\x1b[A",
  Down: "\x1b[B",
  // Application cursor mode (DECCKM) variants; the host picks by the terminal's mode.
  "Up:app": "\x1bOA",
  "Down:app": "\x1bOB",
  // Claude Code's menus (the trust dialog, model picker) ignore arrow keys that
  // arrive through a ConPTY input pipe, but take vi keys. Only for menus: in the
  // prompt box these type letters.
  MenuUp: "k",
  MenuDown: "j",
};
for (const d of "123456789") KEYS[d] = d;

/**
 * Where Claude Code is. The npm shim (`claude.cmd`) wraps a native `claude.exe` next
 * to it; the installer puts `claude.exe` in ~/.local/bin. ConPTY wants a real
 * executable, so a `.cmd` that can't be unwrapped runs through cmd.exe.
 * @returns {{cmd: string, args: string[], display: string} | null}
 */
export function resolveClaude(preferred = "claude") {
  if (/[\\/]/.test(preferred)) return existsSync(preferred) ? asCommand(preferred) : null;
  const candidates = [];
  const r = spawnSync("where.exe", [preferred], { encoding: "utf8" });
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const p = line.trim();
    if (p) candidates.push(p);
  }
  const local = join(homedir(), ".local", "bin", `${preferred}.exe`);
  if (existsSync(local)) candidates.push(local);
  const own = resolve(HERE, "..");
  const usable = candidates.filter((p) => !resolve(p).toLowerCase().startsWith(own.toLowerCase()));
  const exe = usable.find((p) => /\.exe$/i.test(p));
  if (exe) return asCommand(exe);
  const cmd = usable.find((p) => /\.(cmd|bat)$/i.test(p));
  if (cmd) {
    const unwrapped = join(dirname(cmd), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(unwrapped)) return asCommand(unwrapped);
    return asCommand(cmd);
  }
  return null;
}

function asCommand(path) {
  if (/\.(cmd|bat)$/i.test(path)) return { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", path], display: path };
  return { cmd: path, args: [], display: path };
}

/**
 * Start the host detached and windowless, if the pipe doesn't answer.
 *
 * On Windows the host is started through wscript.exe, which starts it hidden and
 * exits at once, so the host is nobody's child: killing the hub's or the CLI's
 * process tree (taskkill /T, a stopped service) leaves it, and the Claude Code
 * sessions it holds, running. `launcherDir` is where that one-line script lives.
 */
export async function ensureHost(pipe = defaultPipe(), { logFile = null, launcherDir = null, timeoutMs = 6000 } = {}) {
  if (await pipeAnswers(pipe)) return false;
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  const args = [HOST_SCRIPT, "--pipe", pipe, ...(logFile ? ["--log", logFile] : [])];
  if (process.platform === "win32" && launcherDir) {
    mkdirSync(launcherDir, { recursive: true });
    const launcher = join(launcherDir, "host-launcher.vbs");
    const q = (s) => `""${String(s).replace(/"/g, '""')}""`;
    writeFileSync(launcher, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${[process.execPath, ...args].map(q).join(" ")}", 0, False\r\n`);
    const wscript = join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
    spawnSync(wscript, [launcher], { stdio: "ignore", windowsHide: true, timeout: 10000 });
  } else {
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    if (await pipeAnswers(pipe)) return true;
  }
  throw new Error(`the session host did not start within ${timeoutMs / 1000}s`);
}

export function pipeAnswers(pipe) {
  return new Promise((done) => {
    const s = netConnect(pipe);
    s.once("connect", () => {
      s.destroy();
      done(true);
    });
    s.once("error", () => done(false));
  });
}

/**
 * A control connection: JSON requests, JSON replies. Reused across calls; a
 * dropped connection is replaced on the next request.
 */
export class HostClient {
  constructor(pipe = defaultPipe()) {
    this.pipe = pipe;
    this.socket = null;
    this.pending = new Map();
    this.seq = 0;
    this.buf = "";
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolveConn, reject) => {
      const s = netConnect(this.pipe);
      s.setNoDelay?.(true);
      s.once("connect", () => {
        this.socket = s;
        this.connecting = null;
        resolveConn(s);
      });
      s.once("error", (err) => {
        this.connecting = null;
        if (this.socket === s) this.socket = null;
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        reject(err);
      });
      s.on("close", () => {
        if (this.socket === s) this.socket = null;
        for (const [, p] of this.pending) p.reject(new Error("host connection closed"));
        this.pending.clear();
      });
      s.on("data", (chunk) => {
        this.buf += chunk.toString("utf8");
        let idx;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result ?? {});
          else p.reject(Object.assign(new Error(msg.error || "host error"), { code: msg.code }));
        }
      });
    });
    return this.connecting;
  }

  async request(op, params = {}, { timeout = 5000 } = {}) {
    const s = await this.connect();
    const id = ++this.seq;
    return new Promise((resolveReq, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`host did not answer ${op} within ${timeout}ms`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolveReq(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      s.write(JSON.stringify({ id, op, ...params }) + "\n");
    });
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}

// ConPTY asks the terminal for win32-input-mode at startup, and the relay passes
// that on, so Windows Terminal sends keys as `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`
// records. Claude Code needs that fidelity (arrow keys, for one), so the records
// are forwarded as they are; only the detach chord is picked out of them.
const WIN32_KEY = /\x1b\[(\d+);(\d+);(\d+);(\d+);(\d+);(\d+)_/g;
const CTRL_RBRACKET = 0x1d;

/** Is Ctrl+] in this input chunk, in any of the ways a Windows terminal can send it? */
export function isDetachChord(chunk) {
  if (chunk.length === 1 && chunk[0] === CTRL_RBRACKET) return true;
  const s = chunk.toString("latin1");
  if (/\x1b\[(93|221);5u/.test(s)) return true; // kitty keyboard protocol, Ctrl+]
  for (const m of s.matchAll(WIN32_KEY)) {
    const uc = Number(m[3]);
    const keyDown = Number(m[4]) === 1;
    if (keyDown && uc === CTRL_RBRACKET) return true;
  }
  return false;
}

// What the terminal is told on attach (win32-input-mode on, as ConPTY itself asks
// at startup) and on detach (every mode the session may have left on, off again).
const ATTACH_MODES = "\x1b[?9001h";
const DETACH_RESET = "\x1b[?9001l\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[<u\x1b[?25h\x1b[0m";

/**
 * Relay this console to a session until it ends or the user detaches (Ctrl+]).
 * @returns {Promise<{reason: "detached"|"ended"|"lost", exitCode?: number}>}
 */
export function attach({ pipe = defaultPipe(), id, stdin = process.stdin, stdout = process.stdout }) {
  return new Promise((done, fail) => {
    const s = netConnect(pipe);
    let finished = false;
    let header = "";
    let headerDone = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      done(result);
    };
    const send = (msg) => {
      if (!s.destroyed) s.write(JSON.stringify(msg) + "\n");
    };
    const onResize = () => send({ op: "resize", cols: stdout.columns || 80, rows: stdout.rows || 24 });
    const onInput = (chunk) => {
      if (process.env.GLANCECODE_ATTACH_DEBUG) appendFileSync(process.env.GLANCECODE_ATTACH_DEBUG, `${Date.now()} in ${JSON.stringify(chunk.toString("latin1"))}\n`);
      if (isDetachChord(chunk)) {
        // Ctrl+]: detach, leaving the session running.
        send({ op: "detach" });
        return finish({ reason: "detached" });
      }
      send({ op: "input", data: chunk.toString("base64") });
    };
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.off("data", onInput);
      stdout.off("resize", onResize);
      if (headerDone) stdout.write(DETACH_RESET);
      if (stdin.isTTY) stdin.setRawMode(!!wasRaw);
      stdin.pause();
      s.destroy();
    };
    s.once("connect", () => {
      send({ op: "attach", session: id, cols: stdout.columns || 80, rows: stdout.rows || 24 });
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onInput);
      stdout.on("resize", onResize);
    });
    s.on("data", (chunk) => {
      if (!headerDone) {
        // The first line is the host's answer; everything after it is terminal output.
        header += chunk.toString("latin1");
        const nl = header.indexOf("\n");
        if (nl < 0) return;
        headerDone = true;
        let reply;
        try {
          reply = JSON.parse(header.slice(0, nl));
        } catch {
          reply = { ok: false, error: "bad reply from host" };
        }
        if (!reply.ok) {
          cleanup();
          return fail(new Error(reply.error || "attach failed"));
        }
        stdout.write(ATTACH_MODES);
        const rest = Buffer.from(header.slice(nl + 1), "latin1");
        if (rest.length) stdout.write(rest);
        return;
      }
      stdout.write(chunk);
    });
    s.on("close", () => finish({ reason: "lost" }));
    s.on("error", (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      fail(err);
    });
  });
}
