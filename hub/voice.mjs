// Getting whisper.cpp onto a Windows PC: its release zip for this CPU, and the
// speech model. Downloads resume from a .part file if interrupted.
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// whisper.cpp's version tags (v1.x) carry no binaries; its build tags do. This one
// is the build whose zips were checked to contain whisper-server.exe.
export const WHISPER_BUILD = "b5454";
export const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

/**
 * The release asset for this machine: CPU builds for x64 and arm64, or the CUDA
 * build for x64 with an NVIDIA GPU. The CUDA zip carries the CUDA runtime DLLs
 * (hence its size), so only a driver is needed.
 */
export function whisperAsset(arch = process.arch, { cuda = false } = {}) {
  if (arch === "arm64") return "whisper-bin-win-cpu-arm64.zip";
  if (arch === "x64") return cuda ? "whisper-bin-win-cuda-12.4.0-x64.zip" : "whisper-bin-x64.zip";
  return null;
}

export function whisperAssetUrl(arch = process.arch, opts = {}) {
  const asset = whisperAsset(arch, opts);
  return asset ? `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}/${asset}` : null;
}

/** An NVIDIA driver installs nvidia-smi.exe into System32; that's the sign of a usable GPU. */
export function hasNvidiaGpu() {
  if (process.platform !== "win32" || process.arch !== "x64") return false;
  return existsSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe"));
}

/** What `installWhisper` put in `dir`, if anything: {build, asset, cuda}. */
export function installedWhisper(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "build.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Download `url` to `dest`, resuming a partial download when the server allows it.
 * @param {(done: number, total: number|null) => void} [onProgress]
 */
export async function downloadFile(url, dest, { onProgress = () => {} } = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = dest + ".part";
  let have = existsSync(part) ? statSync(part).size : 0;
  const headers = have ? { Range: `bytes=${have}-` } : {};
  const res = await fetch(url, { headers, redirect: "follow" });
  if (res.status === 416) {
    // Everything was already there.
    renameSync(part, dest);
    return dest;
  }
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  const resuming = res.status === 206 && have > 0;
  if (!resuming && have) {
    rmSync(part, { force: true });
    have = 0;
  }
  const length = Number(res.headers.get("content-length")) || null;
  const total = length ? have + length : null;
  let done = have;
  let lastReport = 0;
  const progress = new (await import("node:stream")).Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (Date.now() - lastReport > 1000) {
        lastReport = Date.now();
        onProgress(done, total);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(part, { flags: resuming ? "a" : "w" }));
  onProgress(done, total);
  renameSync(part, dest);
  return dest;
}

/**
 * Put whisper-server.exe and its DLLs in `dir`. The zip holds them under Release/.
 * Extraction uses PowerShell's Expand-Archive, so there is nothing to install.
 */
export async function installWhisper(dir, { cuda = false, onProgress, log = () => {} } = {}) {
  const asset = whisperAsset(process.arch, { cuda });
  const url = whisperAssetUrl(process.arch, { cuda });
  if (!url) throw new Error(`no whisper.cpp build for ${process.arch}`);
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, basename(url));
  if (!existsSync(zip)) {
    log(`downloading ${url}`);
    await downloadFile(url, zip, { onProgress });
  }
  const scratch = mkdtempSync(join(tmpdir(), "glancecode-whisper-"));
  try {
    const ps = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${scratch.replace(/'/g, "''")}' -Force`], { encoding: "utf8", windowsHide: true, timeout: 600_000 });
    if (r.status !== 0) throw new Error(`could not unzip ${basename(zip)}: ${(r.stderr || r.stdout || "").trim()}`);
    const release = existsSync(join(scratch, "Release")) ? join(scratch, "Release") : scratch;
    if (!existsSync(join(release, "whisper-server.exe"))) throw new Error(`${basename(zip)} did not contain whisper-server.exe`);
    // A running server holds its files; a build switch has to stop it first, and
    // Windows releases the files a moment after the process ends.
    spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", "Get-Process whisper-server -ErrorAction SilentlyContinue | Stop-Process -Force; Wait-Process -Name whisper-server -Timeout 10 -ErrorAction SilentlyContinue"], { windowsHide: true, timeout: 20_000 });
    for (const f of readdirSync(dir)) {
      if (!/\.(exe|dll|json)$/i.test(f)) continue;
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(join(dir, f), { force: true });
          break;
        } catch (err) {
          if (attempt >= 10) throw err;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
    let moved = 0;
    for (const f of readdirSync(release)) {
      if (!/\.(exe|dll)$/i.test(f)) continue;
      // Only what the server needs: the server, and every DLL it may load.
      if (/\.exe$/i.test(f) && !/^whisper-server\.exe$/i.test(f)) continue;
      renameSync(join(release, f), join(dir, f));
      moved++;
    }
    writeFileSync(join(dir, "build.json"), JSON.stringify({ build: WHISPER_BUILD, asset, cuda }, null, 2) + "\n");
    rmSync(zip, { force: true });
    return { bin: join(dir, "whisper-server.exe"), files: moved, asset };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Download the speech model to `modelPath` unless it is already there. */
export async function installModel(modelPath, { onProgress, log = () => {} } = {}) {
  if (existsSync(modelPath)) return false;
  const url = MODEL_URL + basename(modelPath);
  log(`downloading ${url}`);
  await downloadFile(url, modelPath, { onProgress });
  return true;
}

export function formatProgress(done, total) {
  const mb = (n) => (n / 1e6).toFixed(0);
  return total ? `${mb(done)} / ${mb(total)} MB (${Math.round((100 * done) / total)}%)` : `${mb(done)} MB`;
}
