// Hub configuration and on-disk locations.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { BRAND, env } from "./brand.mjs";
import { defaultPipe } from "../host/client.mjs";

const WIN = process.platform === "win32";
// Windows: config in Roaming AppData, big files (speech model, binaries, logs) in Local.
// Elsewhere (tests, CI): the XDG folders upstream uses.
const CONFIG_BASE = WIN ? process.env.APPDATA || join(homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const DATA_BASE = WIN ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local") : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

export const CONFIG_DIR = env("CONFIG_DIR") || join(CONFIG_BASE, BRAND.name);
export const DATA_DIR = env("DATA_DIR") || join(DATA_BASE, BRAND.name);
export const LOG_DIR = join(DATA_DIR, "logs");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const STATE_FILE = join(CONFIG_DIR, "sessions.json");
// Claude Code's own folder; CLAUDE_CONFIG_DIR moves it.
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CLAUDE_SETTINGS = join(CLAUDE_DIR, "settings.json");
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, "projects");

const DEFAULTS = {
  port: 7717, // API + glasses app, 127.0.0.1 (reached from the phone through `tailscale serve`)
  hookPort: 7718, // hook intake, 127.0.0.1 only, never exposed
  whisperPort: 7719, // local whisper-server, 127.0.0.1 only
  httpsPort: 7443, // tailscale serve HTTPS port on the machine's *.ts.net name
  // Also listen on the raw Tailscale IP over plain HTTP. Only for development
  // sideloads; store builds must use HTTPS through tailscale serve.
  bindTailscaleIP: false,
  // The session host's named pipe. One host per Windows user by default.
  hostPipe: defaultPipe(),
  whisperBin: WIN ? join(DATA_DIR, "whisper", "whisper-server.exe") : "whisper-server",
  whisperModel: join(DATA_DIR, "models", "ggml-large-v3-turbo-q5_0.bin"),
  // CPU threads for whisper-server: about the physical cores, capped so the PC stays usable.
  whisperThreads: Math.max(2, Math.min(8, Math.floor(cpus().length / 2))),
  // Words whisper should expect: project names get appended at runtime.
  sttVocabulary: "Claude, Claude Code, Opus, Sonnet, Haiku, commit, deploy, npm, git",
  // Optional phone push through ntfy (https://ntfy.sh). Off unless a topic is set.
  ntfyTopic: "",
  ntfyServer: "https://ntfy.sh",
  // Extra arguments for sessions the glasses start (for example ["--model", "sonnet"]).
  claudeArgs: [],
  // Keep the machine awake while the hub runs, so the glasses can reach it. Later milestone.
  preventSleep: true,
};

/** Read the raw config file without generating tokens (used at import time). */
function readConfigFile() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export const HOST_PIPE = env("HOST_PIPE") || readConfigFile().hostPipe || DEFAULTS.hostPipe;

export function loadConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let cfg = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch (err) {
      throw new Error(`could not parse ${CONFIG_FILE}: ${err.message}`);
    }
  }
  let changed = false;
  if (!cfg.token) {
    cfg.token = randomBytes(24).toString("base64url");
    changed = true;
  }
  const merged = { ...DEFAULTS, ...cfg };
  if (changed) saveConfig(cfg);
  return merged;
}

export function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  // The profile folders are already private to the user on Windows; elsewhere, make the file so.
  if (!WIN) chmodSync(CONFIG_FILE, 0o600);
}

/** Update individual keys in the config file, keeping everything else. */
export function updateConfig(patch) {
  const cfg = readConfigFile();
  Object.assign(cfg, patch);
  saveConfig(cfg);
  return cfg;
}

/** The machine's Tailscale IPv4 address, if Tailscale is up. */
export function tailscaleAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && a.address.startsWith("100.")) {
        const second = Number(a.address.split(".")[1]);
        if (second >= 64 && second <= 127) return a.address; // CGNAT range Tailscale uses
      }
    }
  }
  return null;
}
