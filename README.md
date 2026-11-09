# GlanceCode for Windows

Drive your Claude Code sessions from Even Realities G2 glasses, from a Windows PC.
See the live transcript, approve tool calls, answer questions, and hold to talk.
Everything runs on your own computer.

This is a Windows-native fork of [GlanceCode](https://github.com/sousyllc/glancecode):
no WSL, no tmux. It follows Claude Code only. The glasses app is upstream's,
unchanged. GlanceCode is an independent project and isn't affiliated with Anthropic
or Even Realities.

Status: milestone 1 of the port (see `docs/windows-design.md`). Sessions, the live
transcript, approvals, interrupt and model switching work through the hub API.
Not ported yet: the background service, voice, keep-awake.

## How it works

Every session is ordinary Claude Code running inside a small **session host**, the
way upstream runs it inside tmux. The host runs Claude Code in a Windows
pseudo-console (ConPTY), keeps a copy of its screen, and lets the hub type into it
and read it back. The hub follows your sessions through Claude Code hooks and their
transcript files. The glasses app talks only to the hub, over your private
Tailscale network.

```
claude.exe (in ConPTY) ◀── keys ─── session host ◀── named pipe ──┬── glancecode claude / attach (your terminal)
        │ screen ──────────────────▶ (headless terminal)            └── hub (127.0.0.1)
        └── hooks ──────────────────────────────────────────────────────▶ hub ◀── tailscale serve (HTTPS) ◀── Even app ◀── G2
            transcript ─────────────────────────────────────────────────▶ hub
```

Claude Code itself is never replaced or modified, so your model, permission mode,
background tasks and Remote Control keep working. There's only ever one Claude
process per session, and the terminal and the glasses see the same conversation.
The host is separate from the hub, so restarting or upgrading the hub leaves your
sessions running.

## What you get on the glasses

- A list of every Claude Code session on your computer, with live state: working,
  idle, or waiting for you.
- The live transcript of any session: prompts, replies, progress notes and tool
  calls, pixel-wrapped for the G2 display.
- Approvals and questions with the exact options the session is offering. Keys are
  only pressed after that dialog is read back from the terminal.
- Start a new session in a recent project, or resume a past session.
- A menu to interrupt, compact, or switch the session's model without changing
  your default.
- Hold to talk, once voice is ported.

## Requirements

On your PC (Windows 10 1809 or newer, Windows 11 recommended):

- Node 20 or newer
- [Claude Code](https://claude.com/claude-code), signed in. The native installer,
  WinGet and npm installs all work.
- [Tailscale](https://tailscale.com/download/windows), signed in, with HTTPS
  certificates turned on for your tailnet at
  [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns)
- Optional, for voice (not ported yet): whisper.cpp's Windows build, downloaded by
  `glancecode setup-voice` when that lands.

Git for Windows is not needed. The hook runs under PowerShell.

On your phone:

- The Even Realities app, paired with your G2 glasses
- Tailscale for iPhone or Android, signed in to the same Tailscale account as
  your PC

## Install (from this checkout, for now)

```powershell
git clone <this repo>
cd wglancecode
npm install
npm run build:app
node bin\glancecode install      # adds the hook to %USERPROFILE%\.claude\settings.json
node bin\glancecode hub          # run the hub in this window (the service comes in milestone 2)
```

Then, in another window, serve the hub over HTTPS and pair:

```powershell
node bin\glancecode serve
node bin\glancecode pair
```

Install **GlanceCode** from Even Hub in the Even Realities app, open it, and paste
the pairing code on the phone screen.

To let the glasses drive a session you start at your desk, start it through the
host:

```powershell
node bin\glancecode claude       # takes the same arguments as claude
```

Sessions started any other way still appear on the glasses, marked view only.
Closing the terminal window only detaches; the session keeps running and
`glancecode attach` opens it again. Ctrl+] detaches on purpose.

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
| `glancecode pair` | print the pairing code again |

## Security

- The hub listens on 127.0.0.1 only. Your phone reaches it through
  `tailscale serve`, so traffic stays inside your tailnet and is encrypted.
- Every request needs the pairing token. Anyone with that token and access to your
  tailnet can type into your sessions, so keep it private. To replace it, delete
  the `token` line in `%APPDATA%\glancecode\config.json` and restart the hub.
- The hook port accepts connections from 127.0.0.1 only.
- The session host listens on a named pipe that only your Windows user can open.
  It never listens on the network.

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
| `whisperBin` | `%LOCALAPPDATA%\glancecode\whisper\whisper-server.exe` | whisper.cpp server, once voice is ported |
| `sttVocabulary` | | words the speech model should expect |
| `ntfyTopic` | empty | optional phone push through ntfy when a session finishes or needs you |
| `bindTailscaleIP` | false | also listen on the raw Tailscale IP over plain HTTP, for development |

## Limitations

- Even Hub apps only run while they're open on the glasses. To hear about a
  session while another app is open, set `ntfyTopic`.
- The G2 display has one font weight, so markdown is shown as plain text.
- Sessions must be started with `glancecode claude` for the glasses to type into
  them.
- Background service, voice and keep-awake are not ported yet.

## Development

```powershell
npm run build:app          # build the glasses app
npm test                   # hub, host and app tests
node bin\glancecode hub    # run the hub in the foreground
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for testing with a scratch config and
[docs/windows-design.md](docs/windows-design.md) for the design.

## Credits

Upstream [GlanceCode](https://github.com/sousyllc/glancecode) by sousy, with ideas
from [cc-g2](https://github.com/wmoto-ai/cc-g2) and
[claude-code-g2](https://github.com/sam-siavoshian/claude-code-g2), and Even
Realities' [templates](https://github.com/even-realities/evenhub-templates). All
MIT licensed.

## License

[MIT](LICENSE)
