// The session host: the tmux server of this port. Runs Claude Code in ConPTY
// pseudo-consoles, keeps a headless terminal screen for each, and lets the hub
// and the CLI type into them, read them back, and attach a console, over a
// user-private named pipe. Kept small and separate from the hub so a hub restart
// never ends a session.
import { createServer } from "node:net";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pty from "@lydell/node-pty";
import xterm from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { KEYS, defaultPipe } from "./client.mjs";

const { Terminal } = xterm;
const { SerializeAddon } = serialize;

const SCROLLBACK = 5000;
const DEFAULT_SIZE = { cols: 200, rows: 50 }; // for sessions nobody is attached to
const MIN_SIZE = { cols: 20, rows: 5 };
const IDLE_EXIT_MS = 10_000; // no sessions and no clients for this long: exit, like tmux
// A host started from inside a Claude Code session (a hub run from Claude's shell)
// would pass these on, and Claude Code then treats the new session as a nested
// child: no transcript, different hooks. Each session is its own.
const NESTED_SESSION_MARKERS = /^(CLAUDECODE|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|EXECPATH|MESSAGING_SOCKET|MESSAGING_TOKEN|BRIDGE_SESSION_ID|SSE_PORT))$/;
const STARTUP_GRACE_MS = 30_000;

export function startHost({ pipe = defaultPipe(), log = () => {}, exitWhenIdle = true } = {}) {
  /** @type {Map<string, Session>} */
  const sessions = new Map();
  const connections = new Set();
  let lastActivity = Date.now();
  let everHadSession = false;

  class Session {
    constructor({ name, cwd, cmd, args, env, cols, rows }) {
      this.id = randomBytes(4).toString("hex");
      this.name = name;
      this.cwd = cwd;
      this.cmd = cmd;
      this.args = args;
      this.title = "";
      this.startedAt = Date.now();
      this.exitCode = null;
      this.cols = cols;
      this.rows = rows;
      /** @type {Set<import("node:net").Socket>} */
      this.attached = new Set();
      this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
      this.serializer = new SerializeAddon();
      this.term.loadAddon(this.serializer);
      this.term.onTitleChange((t) => {
        this.title = t;
      });
      const fullEnv = {};
      for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined && v !== null && !NESTED_SESSION_MARKERS.test(k)) fullEnv[k] = String(v);
      fullEnv.GLANCECODE_HOST = pipe;
      fullEnv.GLANCECODE_PANE = this.id;
      this.pty = pty.spawn(cmd, args, { name: "xterm-256color", cols, rows, cwd, env: fullEnv, useConpty: true });
      this.pty.onData((data) => {
        this.term.write(data);
        for (const s of this.attached) if (!s.destroyed) s.write(data);
      });
      this.pty.onExit(({ exitCode }) => {
        this.exitCode = exitCode ?? 0;
        log(`session ${this.name} (${this.id}) exited ${this.exitCode}`);
        if (this.exitCode !== 0) {
          // A failed start is only ever diagnosable from what it printed.
          const tail = this.screen(12).split("\n").filter((l) => l.trim());
          if (tail.length) log(`  last lines:\n    ${tail.join("\n    ")}`);
        }
        for (const s of this.attached) {
          if (s.destroyed) continue;
          s.write(`\r\n\x1b[0m[glancecode] session ended (exit ${this.exitCode})\r\n`);
          s.end();
        }
        this.attached.clear();
        sessions.delete(this.id);
        touch();
        // node-pty leaves the input pipe and its conout worker open after a natural
        // exit; kill() on the finished pty releases them.
        setTimeout(() => {
          try {
            this.pty.kill();
          } catch {
            /* already released */
          }
        }, 50).unref?.();
      });
    }

    get pid() {
      return this.pty.pid || null;
    }

    get alive() {
      return this.exitCode === null;
    }

    /** The last `lines` logical lines of the screen and scrollback, wrapped rows joined. */
    screen(lines = 60) {
      // Scrollback plus the viewport, like `capture-pane -J`, minus the blank
      // rows under the last thing drawn, so a short screen isn't all blanks.
      const b = this.term.buffer.active;
      const out = [];
      for (let i = 0; i < b.length; i++) {
        const line = b.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true).replace(/\s+$/, "");
        if (line.isWrapped && out.length) out[out.length - 1] += text;
        else out.push(text);
      }
      while (out.length && !out[out.length - 1]) out.pop();
      return out.slice(-lines).join("\n");
    }

    write(data) {
      this.pty.write(data);
    }

    key(name) {
      let seq = KEYS[name];
      if (seq === undefined) throw hostError(400, `key not allowed: ${name}`);
      if ((name === "Up" || name === "Down") && this.term.modes.applicationCursorKeysMode) seq = KEYS[`${name}:app`];
      this.pty.write(seq);
    }

    resize(cols, rows) {
      cols = Math.max(MIN_SIZE.cols, Math.floor(cols) || DEFAULT_SIZE.cols);
      rows = Math.max(MIN_SIZE.rows, Math.floor(rows) || DEFAULT_SIZE.rows);
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      this.term.resize(cols, rows);
      this.pty.resize(cols, rows);
    }

    attach(socket, cols, rows) {
      this.attached.add(socket);
      // Paint the current screen, then let ConPTY repaint for the client's size.
      socket.write("\x1b[H\x1b[2J" + this.serializer.serialize({ scrollback: 0 }));
      if (this.title) socket.write(`\x1b]0;${this.title}\x07`);
      this.resize(cols, rows);
      socket.on("close", () => this.attached.delete(socket));
    }

    kill() {
      try {
        this.pty.kill();
      } catch {
        /* already gone */
      }
    }

    summary() {
      return { id: this.id, name: this.name, cwd: this.cwd, pid: this.pid, title: this.title, attached: this.attached.size, alive: this.alive, startedAt: this.startedAt, cols: this.cols, rows: this.rows };
    }
  }

  function hostError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function touch() {
    lastActivity = Date.now();
  }

  function uniqueName(base) {
    const clean = (base || "claude").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24) || "claude";
    const taken = new Set([...sessions.values()].map((s) => s.name));
    let name = clean;
    for (let n = 2; taken.has(name); n++) name = `${clean}-${n}`;
    return name;
  }

  function sessionOr404(id) {
    const s = sessions.get(id) || [...sessions.values()].find((x) => x.name === id);
    if (!s) throw hostError(404, `no session ${id}`);
    return s;
  }

  const ops = {
    ping: () => ({ pid: process.pid, sessions: sessions.size }),
    list: () => ({ sessions: [...sessions.values()].map((s) => s.summary()) }),
    new({ name, cwd, cmd, args = [], env = {}, cols, rows }) {
      if (!cmd) throw hostError(400, "cmd required");
      if (!cwd) throw hostError(400, "cwd required");
      const s = new Session({ name: uniqueName(name), cwd, cmd, args, env, cols: cols || DEFAULT_SIZE.cols, rows: rows || DEFAULT_SIZE.rows });
      sessions.set(s.id, s);
      everHadSession = true;
      touch();
      log(`new session ${s.name} (${s.id}): ${cmd} ${args.join(" ")} in ${cwd}`);
      return { id: s.id, name: s.name, pid: s.pid };
    },
    alive({ session }) {
      const s = sessions.get(session);
      return { alive: !!s && s.alive, name: s?.name, pid: s?.pid ?? null };
    },
    screen({ session, lines = 60 }) {
      return { text: sessionOr404(session).screen(Math.min(Number(lines) || 60, SCROLLBACK)) };
    },
    write({ session, data }) {
      sessionOr404(session).write(String(data ?? ""));
      return {};
    },
    key({ session, key }) {
      sessionOr404(session).key(String(key));
      return {};
    },
    resize({ session, cols, rows }) {
      sessionOr404(session).resize(Number(cols), Number(rows));
      return {};
    },
    kill({ session }) {
      sessionOr404(session).kill();
      return {};
    },
  };

  const server = createServer((socket) => {
    connections.add(socket);
    touch();
    let buf = "";
    let attachedTo = null;
    socket.setNoDelay?.(true);
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (attachedTo) {
          if (msg.op === "input" && typeof msg.data === "string") attachedTo.write(Buffer.from(msg.data, "base64").toString("utf8"));
          else if (msg.op === "resize") attachedTo.resize(Number(msg.cols), Number(msg.rows));
          else if (msg.op === "detach") socket.end();
          continue;
        }
        if (msg.op === "attach") {
          try {
            const s = sessionOr404(msg.session);
            socket.write(JSON.stringify({ id: msg.id, ok: true, name: s.name }) + "\n");
            attachedTo = s;
            s.attach(socket, Number(msg.cols) || s.cols, Number(msg.rows) || s.rows);
          } catch (err) {
            socket.end(JSON.stringify({ id: msg.id, ok: false, error: err.message, code: err.code }) + "\n");
          }
          continue;
        }
        const fn = ops[msg.op];
        let reply;
        try {
          if (!fn) throw hostError(400, `unknown op ${msg.op}`);
          reply = { id: msg.id, ok: true, result: fn(msg) };
        } catch (err) {
          reply = { id: msg.id, ok: false, error: err.message, code: err.code || 500 };
        }
        if (!socket.destroyed) socket.write(JSON.stringify(reply) + "\n");
      }
    });
    socket.on("close", () => {
      connections.delete(socket);
      touch();
    });
    socket.on("error", () => {});
  });

  server.listen(pipe, () => log(`host listening on ${pipe}`));

  let idleTimer = null;
  if (exitWhenIdle) {
    const started = Date.now();
    idleTimer = setInterval(() => {
      const quietFor = Date.now() - lastActivity;
      const pastGrace = everHadSession || Date.now() - started > STARTUP_GRACE_MS;
      // Control connections don't count: the hub keeps one open for as long as it
      // runs, and a host with nothing to hold should still make way for a newer one.
      if (sessions.size === 0 && quietFor > IDLE_EXIT_MS && pastGrace) {
        log("no sessions and no clients; exiting");
        close();
        process.exit(0);
      }
    }, 2000);
  }

  function close() {
    clearInterval(idleTimer);
    for (const s of connections) s.destroy();
    server.close();
  }

  return { server, sessions, pipe, close };
}

// ---------- standalone ----------
const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const pipe = arg("--pipe") || defaultPipe();
  const logFile = arg("--log");
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(logFile, line);
      } catch {
        /* no log */
      }
    } else process.stdout.write(line);
  };
  const host = startHost({ pipe, log });
  host.server.on("error", (err) => {
    log(`cannot listen on ${pipe}: ${err.message}`);
    process.exit(1);
  });
  process.on("uncaughtException", (err) => log(`uncaught: ${err.stack || err.message}`));
  const stop = () => {
    for (const s of host.sessions.values()) s.kill();
    host.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
