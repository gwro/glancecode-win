# Changelog

GlanceCode for Windows is versioned on its own, starting at 0.1.0. It was forked
from [GlanceCode](https://github.com/sousyllc/glancecode) 0.6.2 (glasses app 0.3.1)
and does not track later upstream releases. Upstream's own history up to the fork
is kept at the end for reference.

## 0.1.0

First release of the Windows port. Pre-release: exercised against a real hub on
Windows 11 with Even's simulator for the glasses app, not yet with G2 glasses.

### Sessions

- A **session host** replaces tmux: a small Node process runs Claude Code in a
  ConPTY pseudo-console, keeps a headless terminal screen for it, and serves the
  hub and the CLI over a user-private named pipe. It is started through a hidden
  launcher so it belongs to no process tree: hub restarts leave sessions running
  and the hub picks them up again, and the host exits by itself when its last
  session ends.
- `glancecode claude [args]` starts Claude Code in the host and attaches the
  console; Ctrl+] or closing the window detaches; `attach` and `ls` work as
  upstream's tmux versions do. The detach chord is recognised in the plain,
  win32-input-mode and kitty keyboard encodings Windows terminals use.
- Claude Code reports to the hub through a Node hook script run under PowerShell;
  Git Bash is not required. Sessions started in a plain terminal appear view-only,
  with Claude's process id resolved while the hook's shell is still alive.
- Live transcript, approvals with the real option labels, questions, interrupt,
  model switch and compact through the same hub API as upstream, so upstream's
  Even Hub glasses app works unchanged. New session in a recent project and Resume
  of a past session work from the glasses.

### Service

- `glancecode service install|uninstall|restart|stop|status`: the hub as a Task
  Scheduler task for the signed-in user, started hidden at logon, restarted within
  a minute if it fails, logging to `%LOCALAPPDATA%\glancecode\logs\hub.log`.
- The PC is held awake (system, not display) while the hub runs on AC power;
  `preventSleep: false` turns it off.
- `doctor` reports Node, Claude Code, the hook, the host, the hub, the service,
  whisper.cpp, Tailscale and HTTPS; `setup` runs the whole install; `pair` draws
  the pairing code as a QR code.

### Voice

- `glancecode setup-voice` downloads whisper.cpp's Windows release (pinned build)
  and the speech model, resuming interrupted downloads. With an NVIDIA GPU it
  installs the CUDA build, which transcribes a sentence in about 70 ms against
  about real time on the CPU; `--cuda` and `--cpu` choose. The hub warms the
  model up at start. `whisperThreads` sizes the CPU build to the machine.

### Robustness

- Dialog reads reject numbered lists with a gap (a read taken while Claude Code's
  UI was mid-redraw) and wait for two matching reads, so a tap on "Yes" cannot
  land on the next option.
- A hub that starts while Claude Code is already waiting on a dialog finds it on
  screen and reports it as waiting.
- Claude Code's menus ignore arrow keys arriving through ConPTY, so menu
  navigation uses vi keys and the trust dialog is confirmed only once "Yes" has
  the focus. A bare Escape is sent as a win32-input-mode key record so conhost
  delivers it at once. Nested-session markers inherited from a parent Claude Code
  session are stripped from launched sessions.

### Not included

- Codex and Gemini CLI support, tmux, launchd and systemd.

### Paths

- Configuration in `%APPDATA%\glancecode`; speech model, whisper.cpp, logs and
  launchers in `%LOCALAPPDATA%\glancecode`.

---

## Upstream history (before the fork)

## 0.6.2

- Codex: resuming a session the hub can't open now says why, and what to do, rather
  than "couldn't open that Codex session". Sessions owned by another Codex server
  (the ChatGPT app's, an IDE's) or living in Codex Cloud can't be opened locally.

## 0.6.1

- Codex: the hub joins Codex's own shared server when Codex's standalone build is
  installed, so the ChatGPT app's remote, the terminal and the glasses can all use
  the same session. Before, the hub ran a separate server and the two collided.
  `glancecode doctor` says which server is in use.

## 0.6.0 (glasses app 0.3.1)

- Gemini CLI support. `glancecode install` adds the hook to Gemini CLI's settings,
  and `glancecode gemini` starts it in tmux. Gemini sessions get the live
  transcript, approvals, hold to talk, interrupt, compact, and new or resumed
  sessions from the glasses.
- The glasses app offers every installed agent when starting a session, and shows
  Gemini's model names.
- Fixed: a session started from the glasses could be matched to another tmux
  server's session, since pane ids repeat across servers.
- Fixed: a session whose tmux pane has gone now ends even if its process lingers.
- Fixed: a transcript replaced by a rewritten file is read again from the start.

## 0.5.0 (glasses app 0.3.0)

- Codex support. The hub joins Codex's app server as one more client, so Codex
  sessions show on the glasses with their live transcript, approvals, questions,
  hold to talk, interrupt, compact and model switching, while the terminal shows
  the same thing.
- `glancecode codex` starts Codex attached to that server, like `glancecode claude`.
- New session on the glasses asks whether to start Claude Code or Codex, and Resume
  lists past sessions from both, including ones from the Codex desktop app.
- The session menu lists the models the session's agent offers.
- A new, empty session says to hold to talk instead of showing a blank screen.

## 0.4.1

- The hub keeps a plugged-in Mac awake, so a sleeping machine no longer looks
  like a dead hub from the glasses. Turn it off with `"preventSleep": false`.

## 0.4.0

- Removed the Plausible stats calendar feed (`glancecode stats`, `statsProducts`,
  `/api/stats.ics`). It had nothing to do with Claude Code sessions.

## 0.3.0 (glasses app 0.2.4)

- Terminal tabs show Claude Code's session title for sessions inside tmux.
- Voice: a transcript waits for a tap to send; it no longer sends by itself.
  Hold again to re-record, double-tap to cancel.
- Sessions no longer freeze on "Loading…" after opening the glasses menu or a
  dropped connection; the app recovers after the hub restarts and keeps the
  WebView awake while a working session is on screen.

## 0.2.0

First public release.

- Hub follows every Claude Code session through hooks and transcripts, and
  types into sessions that run inside tmux.
- Glasses app: session list, live transcript, approvals and questions with the
  real option labels, hold to talk with a live preview, new and resumed
  sessions, and a menu for interrupt, model switch and compact.
- Local speech to text with whisper.cpp.
- `glancecode setup`, `doctor`, `serve` (HTTPS through tailscale serve) and `pair`.
- Background service on macOS (launchd) and Linux (systemd user unit).
- Built-in demo in the glasses app, used before pairing.
- Optional Plausible stats as a subscribed calendar for the G2 dashboard.
