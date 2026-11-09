// Session control through the host: find panes, type into Claude Code, read the
// screen, launch sessions. The host replaces tmux on Windows; see host/host.mjs.
import { basename } from "node:path";
import { join } from "node:path";
import { DATA_DIR, HOST_PIPE } from "./config.mjs";
import { HostClient, defaultPipe, ensureHost, resolveClaude } from "../host/client.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST_LOG = join(DATA_DIR, "logs", "host.log");

/** One control connection per host pipe, reused across calls. */
const clients = new Map();
function clientFor(pipe = HOST_PIPE) {
  let c = clients.get(pipe);
  if (!c) {
    c = new HostClient(pipe);
    clients.set(pipe, c);
  }
  return c;
}

/**
 * A pane is identified by its host's pipe plus the host's session id, the way a
 * tmux pane is identified by socket path plus pane id.
 * @typedef {{host: string, pane: string}} Target
 */
export function paneKey(target) {
  if (!target?.pane || !target?.host) return null;
  return `${target.host.toLowerCase()}|${target.pane}`;
}

/** Target for the pane a hook reported, or null when it didn't run in a host. */
export function targetFromHook({ host, pane }) {
  if (!host || !pane) return null;
  return { host, pane };
}

async function host(target, op, params = {}, opts) {
  return clientFor(target.host).request(op, { session: target.pane, ...params }, opts);
}

/** True when the session still exists in its host. A host that's gone means no. */
export async function paneAlive(target) {
  try {
    return (await host(target, "alive")).alive === true;
  } catch {
    return false;
  }
}

/** Name and process id the host has for a pane, if it still has it. */
export async function paneInfo(target) {
  try {
    const r = await host(target, "alive");
    return r.alive ? { name: r.name, pid: r.pid } : null;
  } catch {
    return null;
  }
}

export async function capture(target, lines = 60) {
  const { text } = await host(target, "screen", { lines });
  return text.replace(/\s+$/gm, "");
}

/**
 * What is Claude Code showing at the bottom of the pane?
 * @returns {{kind: "permission"|"question"|"trust"|"input"|"unknown", options: string[]}}
 */
export function readDialog(screen) {
  const tail = screen.split("\n").filter((l) => l.trim()).slice(-30);
  const joined = tail.join("\n");
  const options = [];
  for (const l of tail) {
    const m = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/.exec(l);
    if (m) options[Number(m[1]) - 1] = m[2];
  }
  const clean = options.filter(Boolean);
  if (/Yes, I trust this folder/.test(joined)) return { kind: "trust", options: clean };
  if (/Do you want to (proceed|make this edit|create|allow)/i.test(joined) && clean.length) return { kind: "permission", options: clean };
  if (/Enter to select/.test(joined) && clean.length) return { kind: "question", options: clean };
  if (/^\s*❯\s*/m.test(tail.slice(-4).join("\n"))) return { kind: "input", options: [] };
  return { kind: "unknown", options: clean };
}

/** Type a prompt into Claude Code's input box and submit it. */
export async function sendPrompt(target, text) {
  const flat = String(text).replace(/\r?\n+/g, " ").trim();
  if (!flat) return;
  await host(target, "write", { data: flat });
  await sleep(120); // let the TUI absorb a paste-sized burst before submitting
  await host(target, "key", { key: "Enter" });
}

const KEY_WHITELIST = new Set(["Escape", "Enter", "Up", "Down", "MenuUp", "MenuDown", "Tab", "BTab", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

export async function sendKey(target, key) {
  if (!KEY_WHITELIST.has(key)) throw new Error(`key not allowed: ${key}`);
  await host(target, "key", { key });
}

/**
 * Press an option number only if the expected dialog is on screen, so a digit
 * never lands in the prompt box by accident.
 */
export async function chooseOption(target, expectedKind, index) {
  const dialog = readDialog(await capture(target));
  if (dialog.kind !== expectedKind) {
    throw Object.assign(new Error(`no ${expectedKind} dialog on screen (saw ${dialog.kind})`), { status: 409 });
  }
  if (index < 0 || index >= dialog.options.length || index > 8) {
    throw Object.assign(new Error(`option ${index + 1} not available`), { status: 400 });
  }
  await sendKey(target, String(index + 1));
  return dialog.options[index];
}

/**
 * Switch the session's model with /model, confirm the cache-reset dialog if it
 * appears, and put the user's saved default back: /model also rewrites the
 * default in settings.json, and a glasses switch should only change this session.
 */
export async function switchModel(target, model, settingsPath) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const readModel = () => {
    try {
      return JSON.parse(readFileSync(settingsPath, "utf8")).model;
    } catch {
      return undefined;
    }
  };
  const before = readModel();
  await sendPrompt(target, `/model ${model}`);
  const until = Date.now() + 4000;
  let confirmed = false;
  while (Date.now() < until) {
    await sleep(300);
    const screen = await capture(target, 30);
    const m = /(\d+)\.\s+Yes, switch to/.exec(screen);
    if (m && !confirmed) {
      await sendKey(target, m[1]);
      confirmed = true;
      continue;
    }
    if (/Set model to/.test(screen.split("\n").slice(-12).join("\n"))) break;
  }
  await sleep(300);
  const after = readModel();
  if (after !== before) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (before === undefined) delete settings.model;
    else settings.model = before;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return { restoredDefault: after !== before ? before ?? null : null };
}

/** Answer a question with free text via its "Type something" option. */
export async function answerWithText(target, text) {
  const dialog = readDialog(await capture(target));
  if (dialog.kind !== "question") throw Object.assign(new Error("no question on screen"), { status: 409 });
  const idx = dialog.options.findIndex((o) => /^Type something/i.test(o));
  if (idx < 0) throw Object.assign(new Error("question has no free-text option"), { status: 400 });
  await sendKey(target, String(idx + 1));
  await sleep(250);
  await sendPrompt(target, text);
}

export function sessionNameFor(cwd, taken) {
  const base = (basename(cwd || "") || "claude").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24) || "claude";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

/** Sessions in our host, by name. */
export async function listOurSessions(pipe = HOST_PIPE) {
  try {
    const { sessions } = await clientFor(pipe).request("list");
    return sessions;
  } catch {
    return []; // no host running
  }
}

/**
 * Start Claude Code in a detached session on our host, starting the host if needed.
 * @returns {Promise<{name: string, target: Target}>}
 */
export async function launchClaude({ cwd, args = [], claudeBin = "claude", env = {}, pipe = HOST_PIPE }) {
  const claude = resolveClaude(claudeBin);
  if (!claude) throw Object.assign(new Error("Claude Code not found on PATH"), { status: 503 });
  await ensureHost(pipe, { logFile: HOST_LOG, launcherDir: DATA_DIR });
  const taken = new Set((await listOurSessions(pipe)).map((s) => s.name));
  const name = sessionNameFor(cwd, taken);
  const r = await clientFor(pipe).request("new", { name, cwd, cmd: claude.cmd, args: [...claude.args, ...args], env, cols: 200, rows: 50 });
  return { name: r.name, target: { host: pipe, pane: r.id } };
}

/** Accept the folder-trust dialog if it appears within `waitMs`. */
export async function acceptTrustIfShown(target, waitMs = 8000) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    let dialog;
    try {
      dialog = readDialog(await capture(target));
    } catch {
      return false;
    }
    if (dialog.kind === "trust") {
      // The trust dialog is an unnumbered two-item menu with "No, exit" focused.
      // Arrow keys don't move it through ConPTY; the vi key does (see KEYS). A key
      // sent while the dialog is still mounting is dropped, so move, check that
      // "Yes" has the focus, and only then confirm.
      for (let attempt = 0; attempt < 4; attempt++) {
        await sleep(attempt ? 400 : 600);
        await sendKey(target, "MenuDown");
        await sleep(400);
        const focused = (await capture(target, 20)).split("\n").find((l) => /❯/.test(l)) || "";
        if (/Yes, I trust/.test(focused)) {
          await sendKey(target, "Enter");
          return true;
        }
      }
      return false; // leave it for the user rather than guess
    }
    if (dialog.kind === "input") return false;
    await sleep(400);
  }
  return false;
}

/** Wait until Claude Code shows its input prompt. */
export async function waitForInput(target, waitMs = 20000) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      if (readDialog(await capture(target)).kind === "input") return true;
    } catch {
      /* pane not ready */
    }
    await sleep(400);
  }
  return false;
}

/** Whitespace-insensitive snippet used to confirm a prompt reached Claude Code. */
export function promptSnippet(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 40);
}

export function screenHasSnippet(screen, snippet) {
  if (!snippet) return true;
  const flat = screen.replace(/\s+/g, " ");
  // Wrapped lines add spaces at arbitrary points, so also compare with spaces removed.
  return flat.includes(snippet) || flat.replace(/ /g, "").includes(snippet.replace(/ /g, ""));
}

export { defaultPipe };
