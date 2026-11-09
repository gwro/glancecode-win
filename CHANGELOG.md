# Changelog

This is the Windows-native fork of [GlanceCode](https://github.com/sousyllc/glancecode).
Entries below the fork line are upstream's.

## Unreleased (Windows fork, milestone 2)

- `glancecode service install|uninstall|restart|stop|status`: the hub as a Task
  Scheduler task for the signed-in user, started at logon through a hidden
  `wscript` launcher so no console window appears, restarted within a minute if
  it fails, logging to `%LOCALAPPDATA%\glancecode\logs\hub.log`.
- The session host is started through the same kind of launcher, so it is
  nobody's child: stopping or restarting the hub service leaves the host and its
  Claude Code sessions running, and the restarted hub picks them up again.
- `doctor` reports the service, the host, the hook, Tailscale and HTTPS state;
  `setup` runs the whole install.

## Unreleased (Windows fork, milestone 1)

- Windows native: no WSL, no tmux. A small **session host** runs Claude Code in a
  ConPTY pseudo-console, keeps a headless terminal screen for it, and the hub and
  the CLI reach it over a user-private named pipe. Hub restarts leave sessions
  running, and the host exits by itself when its last session ends.
- `glancecode claude [args]` starts Claude Code in the host and attaches this
  console to it; closing the window or Ctrl+] detaches. `glancecode attach` and
  `glancecode ls` work the same way as upstream's tmux versions.
- The hub follows sessions through a Node hook script that Claude Code runs under
  PowerShell (`bin/glancecode-hook.mjs`), on both host sessions and sessions
  started in a plain terminal (view-only).
- Live transcript, approvals with the real option labels, interrupt, model switch
  and compact through the same hub API as upstream, so the Even Hub glasses app
  is unchanged.
- Config in `%APPDATA%\glancecode`, data and logs in `%LOCALAPPDATA%\glancecode`.
- Removed: Codex and Gemini CLI support, tmux, launchd/systemd. Not yet ported:
  `service` (Task Scheduler), `setup-voice` (whisper.cpp download), keep-awake.
- Found along the way: Claude Code's menus ignore arrow keys that arrive through a
  ConPTY input pipe but take vi keys, a lone Escape is delayed by conhost unless
  sent as a win32-input-mode key record, and a session launched from inside
  another Claude Code session inherits markers that turn off its transcript.

---

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
