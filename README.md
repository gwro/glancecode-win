# GlanceCode for Windows

> **Untested on real glasses, provided as-is.** This port has been exercised
> against a real hub on Windows 11 using Even's simulator for the glasses app, but
> it has not yet been used with G2 glasses. It comes with no guarantees or
> support; use it at your own risk, as the [MIT license](LICENSE) states.

A Windows-native port of [GlanceCode](https://github.com/sousyllc/glancecode):
drive your Claude Code sessions from Even Realities G2 glasses. See the live
transcript, approve tool calls, answer questions, and hold to talk. Everything runs
on your own PC and your own Tailscale network.

GlanceCode is an independent project by [sousy](https://github.com/sousyllc). This
fork adapts its hub and command-line tool to Windows; the glasses app is upstream's,
unchanged, and pairs with this hub as it would with the original. Neither project is
affiliated with Anthropic, Even Realities or Microsoft.

## About this fork

Upstream GlanceCode runs on macOS and Linux and relies on tmux to hold each Claude
Code session, type into it and read its screen; on launchd or systemd for the
background service; and on Homebrew for whisper.cpp. None of those exist on Windows,
and running them through WSL would put Claude Code in a different operating system
from your editor and your files.

This fork replaces each of those pieces with its Windows equivalent and keeps
everything else: the hub's HTTP API, the session model, the transcript reader and
the glasses app are the same as upstream's, so the same Even Hub app works with
both.

| Upstream | This fork |
|---|---|
| tmux server, `send-keys`, `capture-pane` | A **session host**: a small Node process that runs Claude Code in a Windows pseudo-console (ConPTY), keeps a headless copy of its screen, and serves the hub and the CLI over a user-private named pipe |
| `glancecode-hook` (bash + curl) | A Node script that Claude Code runs under PowerShell; no Git Bash required |
| launchd / systemd user service | A Task Scheduler task for the signed-in user, started hidden at logon, restarted on failure, logging to `%LOCALAPPDATA%\glancecode\logs` |
| `caffeinate` | A helper holding the system awake (not the display) while on AC power |
| `brew install whisper-cpp` | `setup-voice` downloads whisper.cpp's Windows release and the speech model; on a PC with an NVIDIA GPU it installs the CUDA build |
| Codex and Gemini CLI support | Not included. The fork follows Claude Code only. |

The fork is versioned on its own, starting at 0.1.0. It was taken from upstream
0.6.2 (glasses app 0.3.1) and does not track later upstream releases; see
[CHANGELOG.md](CHANGELOG.md).

The design, the decisions behind it and what the implementation found along the way
are written up in [docs/windows-design.md](docs/windows-design.md). Two of those
findings apply to upstream as well: a screen read taken while Claude Code's UI is
mid-redraw can miss a line of a numbered dialog, and a hub that starts while Claude
is already waiting on a dialog should find it on screen. Both are handled here.

**Status.** The port is feature-complete. Sessions, the live transcript, approvals
with the real option labels, interrupt, model switching, new and resumed sessions,
the background service and hold to talk have all been exercised against a real hub
on Windows 11, using Even's simulator for the glasses app. Testing on the glasses
themselves is the remaining step.

## How it works

Every session is ordinary Claude Code running inside the session host, the way
upstream runs it inside tmux. The host runs Claude Code in a pseudo-console, keeps a
copy of its screen, and lets the hub type into it and read it back. The hub follows
your sessions through Claude Code hooks and their transcript files. The glasses app
talks only to the hub, over your private Tailscale network.

```
claude.exe (in ConPTY) ◀── keys ─── session host ◀── named pipe ──┬── glancecode claude / attach (your terminal)
        │ screen ──────────────────▶ (headless terminal)            └── hub (127.0.0.1)
        └── hooks ──────────────────────────────────────────────────────▶ hub ◀── tailscale serve (HTTPS) ◀── Even app ◀── G2
            transcript ─────────────────────────────────────────────────▶ hub
```

Claude Code itself is never replaced or modified, so your model, permission mode,
background tasks and Remote Control keep working. There is only ever one Claude
process per session, and the terminal and the glasses see the same conversation.
The host is a separate process from the hub, so restarting or upgrading the hub
leaves your sessions running, and the hub picks them up again when it comes back.

## What you get on the glasses

- A list of every Claude Code session on your PC, with live state: working, idle,
  or waiting for you.
- The live transcript of any session: prompts, replies, progress notes and tool
  calls, wrapped for the G2 display.
- Approvals and questions with the exact options the session is offering. Keys are
  only pressed after that dialog has been read back from the terminal.
- Start a new session in a recent project, or resume a past session.
- A menu to interrupt, compact, or switch the session's model without changing
  your default.
- Hold to talk. Words appear while you speak. Release to review, then tap to send.

## Requirements

On your PC (Windows 10 version 1809 or newer; Windows 11 recommended):

- Node.js 20 or newer
- [Claude Code](https://claude.com/claude-code), signed in. The native installer,
  WinGet and npm installs all work. Git for Windows is not required.
- [Tailscale](https://tailscale.com/download/windows), signed in, with HTTPS
  certificates enabled for your tailnet at
  [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns)
- Optional, for voice: nothing to install by hand. `glancecode setup-voice`
  downloads whisper.cpp and the speech model (about 550 MB) into
  `%LOCALAPPDATA%\glancecode`. With an NVIDIA GPU it takes the CUDA build (about
  685 MB, runtime included; only the normal driver is needed), which transcribes a
  sentence in under a tenth of a second. The CPU build (`--cpu`) takes about as
  long as the speech itself. Transcription is local and offline; there is no API
  key or subscription. Without it, everything except hold to talk still works.

On your phone:

- The Even Realities app, paired with your G2 glasses
- Tailscale for iPhone or Android, signed in to the same Tailscale account as the PC

## Install

From a checkout of this repository, in PowerShell:

```powershell
git clone https://github.com/gwro/glancecode-win.git
cd glancecode-win
npm install
npm run build:app
node bin\glancecode setup
```

`setup` checks the requirements, adds the hook to `%USERPROFILE%\.claude\settings.json`,
registers the hub as a Task Scheduler task that starts at logon, serves it over
HTTPS on your `*.ts.net` name, downloads the speech model, and prints a pairing
code. Each step is also its own command (`install`, `service install`, `serve`,
`setup-voice`, `pair`), and `doctor` reports which pieces are missing.

Then install **GlanceCode** from Even Hub in the Even Realities app, open it, and
paste the pairing code on the phone screen, or scan the QR code that `pair` prints.

To let the glasses drive a session you start at your desk, start it through the
host:

```powershell
node bin\glancecode claude       # takes the same arguments as claude
```

Sessions started any other way still appear on the glasses, marked view only.
Closing the terminal window only detaches; the session keeps running and
`glancecode attach` opens it again. Ctrl+] detaches deliberately.

To have `glancecode` on your PATH instead of `node bin\glancecode`, run
`npm install -g .` from the checkout. The installed service keeps working, since it
refers to the checkout by absolute path.

## Using it

| Gesture | Session list | Session |
|---|---|---|
| Swipe | move | scroll, or move between options |
| Tap | open | choose the highlighted option, or jump to the latest |
| Hold | talk to the highlighted session | talk, or answer an open question; hold again to redo |
| Double-tap | exit | back |
| Tap then hold | menu | interrupt, jump to latest, switch model, compact |

At your desk:

| Command | What it does |
|---|---|
| `glancecode claude [args]` | start Claude Code in the host and attach this console |
| `glancecode attach [name]` | open a running session in this terminal |
| `glancecode ls` | list sessions |
| `glancecode feed` | a readable live feed of every session |
| `glancecode status` | hub and sessions |
| `glancecode doctor` | check every piece and say what to fix |
| `glancecode pair` | print the pairing code and its QR code |
| `glancecode service restart` | restart the hub; running sessions are untouched |
| `glancecode setup-voice [--cuda\|--cpu]` | install or switch the whisper.cpp build |

Logs are in `%LOCALAPPDATA%\glancecode\logs`: `hub.log` for the hub and `host.log`
for the session host.

## Security

- The hub listens on 127.0.0.1 only. Your phone reaches it through
  `tailscale serve`, so traffic stays inside your tailnet and is encrypted.
- Every request needs the pairing token. Anyone with that token and access to your
  tailnet can type into your sessions, so keep it private. To replace it, delete
  the `token` line in `%APPDATA%\glancecode\config.json` and restart the hub.
- The hook port accepts connections from 127.0.0.1 only.
- The session host listens on a named pipe that only your Windows user can open.
  It never listens on the network.
- Voice is transcribed on your PC. Audio is not sent anywhere else.

See [SECURITY.md](SECURITY.md) and [docs/privacy.md](docs/privacy.md).

## Configuration

`%APPDATA%\glancecode\config.json` is created on first run.

| Key | Default | Purpose |
|---|---|---|
| `port` | 7717 | hub API on 127.0.0.1 |
| `httpsPort` | 7443 | HTTPS port on your `*.ts.net` name |
| `hookPort` | 7718 | hook intake on 127.0.0.1 |
| `hostPipe` | `\\.\pipe\glancecode-host-<user>` | the session host's named pipe |
| `claudeArgs` | `[]` | extra arguments for sessions started from the glasses |
| `whisperBin` | `%LOCALAPPDATA%\glancecode\whisper\whisper-server.exe` | whisper.cpp server, as installed by `setup-voice`; point it at your own build to use that instead |
| `whisperThreads` | half the logical CPUs, 2 to 8 | CPU threads for transcription (CPU build) |
| `sttVocabulary` | | words the speech model should expect |
| `ntfyTopic` | empty | optional phone push through ntfy when a session finishes or needs you |
| `preventSleep` | true | keep the PC awake (not the display) while the hub runs and the PC is on AC power |
| `bindTailscaleIP` | false | also listen on the raw Tailscale IP over plain HTTP, for development |

## Limitations

- Even Hub apps only run while they are open on the glasses. To hear about a
  session while another app is open, set `ntfyTopic`.
- The G2 display has one font weight, so markdown is shown as plain text.
- Sessions must be started with `glancecode claude` for the glasses to type into
  them. Others are view only.
- Voice on the CPU build runs at about real time, so the live preview while holding
  lags behind speech; the CUDA build does not. There is no prebuilt whisper.cpp
  server for AMD or Intel GPUs, but `whisperBin` can point at your own build.
- Codex and Gemini CLI, which upstream supports, are not included.

## Development

```powershell
npm install
npm run build:app          # build the glasses app
npm test                   # hub, host and app tests
node bin\glancecode hub    # run the hub in the foreground
```

The hub itself has no runtime dependencies, as upstream's doesn't. The session host
uses two: `@lydell/node-pty` for ConPTY, which ships prebuilt binaries for x64 and
ARM64 Windows, and `@xterm/headless` for the screen buffer. The CLI uses
`qrcode-terminal` for the pairing code.

[CONTRIBUTING.md](CONTRIBUTING.md) covers testing against a scratch configuration
and driving the glasses app in Even's simulator without hardware.
[docs/windows-design.md](docs/windows-design.md) is the design and the record of
what each stage of the port found.

## Acknowledgements

This fork exists because of [GlanceCode](https://github.com/sousyllc/glancecode) by
[sousy](https://github.com/sousyllc), whose hub design, transcript reader and
glasses app are used here with gratitude. Upstream in turn credits
[cc-g2](https://github.com/wmoto-ai/cc-g2),
[claude-code-g2](https://github.com/sam-siavoshian/claude-code-g2) and Even
Realities' [templates](https://github.com/even-realities/evenhub-templates). The
Windows port adds [node-pty](https://github.com/lydell/node-pty) by Simon Lydell,
[xterm.js](https://github.com/xtermjs/xterm.js) and
[whisper.cpp](https://github.com/ggml-org/whisper.cpp). All MIT licensed.

## License

[MIT](LICENSE), as upstream.
