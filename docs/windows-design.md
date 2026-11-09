# GlanceCode for Windows: design

This fork makes GlanceCode run natively on Windows: no WSL, no tmux, no Git Bash
needed at runtime. The glasses app is untouched. The first version follows Claude
Code only; Codex and Gemini CLI are out of scope, but the seams upstream uses for
them are kept so they can come back later.

Status: milestone 1 implemented (host, pane layer, hook, CLI sessions). See
"What milestone 1 found" at the end for what differed from this design.

## What stays the same

Everything the glasses see. The hub's HTTP API, the SSE event stream, the session
and item shapes, pairing (`https://<name>.ts.net:7443#<token>`) and the Even Hub
app are identical, so the store build of the glasses app pairs with a Windows hub
as it is. The parts of the hub that read Claude Code's transcripts
(`hub/transcript.mjs`), keep the session registry (`hub/sessions.mjs`) and serve
the API (`hub/server.mjs`) port with small edits, because they only read files and
listen on 127.0.0.1.

## What has to change

Upstream leans on five Unix things. Each has a Windows replacement:

| Upstream (macOS/Linux) | Role | Windows |
|---|---|---|
| tmux server, `send-keys`, `capture-pane` | hold the Claude Code terminal, type into it, read its screen | a **session host**: a small Node process that runs Claude Code in a ConPTY pseudo-console, keeps a headless terminal screen for it, and exposes both over a named pipe |
| `bin/glancecode-hook` (bash + curl) | post hook events to the hub, tagged with `$TMUX_PANE` | a Node script run by Claude Code through PowerShell, tagged with the host session id from the environment |
| launchd / systemd user unit | run the hub at login, restart it | a Task Scheduler logon task with restart on failure, launched hidden |
| `tailscale serve` | HTTPS on the machine's `*.ts.net` name | the same command; Tailscale for Windows ships `tailscale.exe` |
| `brew install whisper-cpp` | local speech to text | `whisper-server.exe` from whisper.cpp's Windows release zip, downloaded by `setup-voice` next to the model |

Plus the usual portability: `~/.config` and `~/.local/share` become `%APPDATA%`
and `%LOCALAPPDATA%`, `/bin/sh -c command -v` becomes `where.exe`, `chmod 600` is
a no-op, and nothing assumes `/` as the path separator.

## Architecture

```
claude.exe (in ConPTY) ◀── keys ─── session host ◀── named pipe ──┬── glancecode claude / attach (your terminal)
        │ screen bytes ─────────────▶ (headless xterm buffer)       └── hub (127.0.0.1:7717)
        │                                                               ▲        ▲
        └── hooks ── powershell ── node glancecode-hook.mjs ── POST 127.0.0.1:7718  │
            transcript %USERPROFILE%\.claude\projects\<dir>\<id>.jsonl ── hub tails ┘
                                                                                 │
   whisper-server.exe (127.0.0.1:7719) ◀── hub ◀── tailscale serve (HTTPS) ◀── Even app ◀── G2
```

Three processes on the computer, all running as the signed-in user:

- **host**: the tmux replacement. Owns the Claude Code processes. Starts on
  demand, exits when its last session ends. Deliberately tiny and rarely changed,
  so hub upgrades and restarts never kill a running Claude session.
- **hub**: unchanged in role. Registry, transcript tailing, API, hook intake,
  voice, notifications. Talks to the host over the pipe the way it talked to tmux
  through `execFile("tmux", ...)`.
- **CLI** (`glancecode`): setup, doctor, service, serve, pair, and the terminal
  client that attaches to a host session.

## The session host

### Why a host, and not something else

Options considered:

1. **Drive Claude Code through its terminal, as upstream does.** Needs something
   that owns the terminal and can type into it and read it back. On Windows that
   is ConPTY, which is what Windows Terminal and VS Code use to run console
   programs. This keeps the upstream model: one Claude process, visible in your
   terminal, the glasses typing into the same session, dialogs confirmed on
   screen before a key is pressed.
2. **Drive Claude Code through an API instead of its UI.** Claude Code documents
   no local protocol for sending prompts or answering permissions into a running
   interactive session. Remote Control is outbound-only, `--input-format
   stream-json` is for print mode, and cross-session messaging can hand an idle
   session a prompt but "can't answer a pending permission prompt". Codex
   upstream works this way because Codex has an app server its terminal UI also
   uses; Claude Code has no public equivalent.
3. **Send keystrokes to a Windows Terminal window** (SendInput, UI Automation).
   Needs the window focused and visible, breaks when you alt-tab. No.

Option 1, with the host as a separate process (like the tmux server) rather than
inside the hub, so that `glancecode service restart` or an upgrade leaves sessions
running, and `glancecode claude` works even when the hub is down.

### Process model

- Binary: `node host/host.mjs`, started detached and windowless by whoever needs
  it first (the CLI for `glancecode claude`, the hub for a launch from the
  glasses). One per user, guarded by the named pipe: if the pipe answers, join it.
- Listens on `\\.\pipe\glancecode-host-<username>`. Named pipes are local only,
  and the default ACL limits them to the same user, which matches tmux's socket
  permissions.
- Each session: a ConPTY from `@lydell/node-pty` running Claude Code, a headless
  `@xterm/headless` terminal that every byte of output is written to (this is the
  `capture-pane` buffer), and zero or more attached terminal clients that get the
  same bytes live.
- The host exits when it has had no sessions and no clients for a few seconds,
  like a tmux server with no sessions.

### Protocol

Newline-delimited JSON over the pipe, one control connection per client, plus a
raw connection for an attach stream.

| Request | Reply | tmux equivalent |
|---|---|---|
| `new {name, cwd, cmd, args, env, cols, rows}` | `{id, name, pid}` | `new-session -d` |
| `list` | `[{id, name, cwd, pid, attached, alive, title}]` | `list-sessions` |
| `alive {id}` | `{alive}` | `display-message #{pane_id}` |
| `screen {id, lines}` | `{text}`: last N logical lines, wrapped rows joined | `capture-pane -p -J -S -N` |
| `write {id, data}` | ok | `send-keys -l` |
| `key {id, key}` | ok; same whitelist as upstream (`Enter`, `Escape`, `Up`, `Down`, `Tab`, `BTab`, `1`…`9`), sent as VT sequences | `send-keys Enter` |
| `resize {id, cols, rows}` | ok | client resize |
| `kill {id}` | ok | `kill-session` |
| `attach {id}` on a raw connection | the current screen (serialized with `@xterm/addon-serialize`), then live output; input bytes flow back | `attach-session` |

Session identity for the hub: the pipe name plus the host's session id, standing
in for tmux's socket path plus pane id (`paneKey` in `hub/tmux.mjs`). The host
sets `GLANCECODE_HOST=<pipe name>` and `GLANCECODE_PANE=<id>` in the ConPTY's
environment so the hook can report which session it belongs to, the way `$TMUX`
and `$TMUX_PANE` do upstream. Claude Code's hooks inherit the parent environment
(documented), so these reach the hook.

### Copy mode, scrolling, and the things tmux did for free

- No copy mode. Scrolling in Windows Terminal scrolls the terminal's own buffer,
  not the ConPTY, so typed keys always reach Claude Code. `leaveCopyMode` goes.
- Resize: the ConPTY takes the size of the most recently attached client, and
  200×50 for a session nobody is attached to (upstream's launch size). Claude Code
  reflows on resize, so a detached session that later gets attached redraws.
- Scrollback: the headless terminal keeps 5000 lines, so `screen` can look back
  as far as upstream's `capture-pane -S -60` ever needs.
- The terminal title Claude Code sets is forwarded to attached clients, so the
  Windows Terminal tab shows the session title as it does upstream.

### Starting Claude Code

Claude Code on Windows is the native `claude.exe`, whether it came from the
installer (`%USERPROFILE%\.local\bin\claude.exe`), WinGet, or npm (the npm package
installs the same binary and exposes it through a `claude.cmd` shim). The host
resolves the command with `where.exe`, prefers a `.exe`, and runs a `.cmd` through
`cmd.exe /d /c` so ConPTY gets a real executable. There is no login-shell wrapper:
a process started from a logon task or the hub already has the user's registry
environment, which is where PATH lives on Windows. `GLANCECODE_HOOK_PORT` is
passed as upstream does.

### The attach client

`glancecode claude [args]` and `glancecode attach [name]` run a thin client in the
current console: stdin in raw mode → pipe → ConPTY; ConPTY output → stdout; window
resize → `resize`. Closing the window drops the pipe and only detaches. A detach
key (Ctrl+]) is offered too. On attach the client receives the serialized screen
first, so a session that has been running headless appears exactly as it is.

Windows Terminal, the legacy console and VS Code's terminal all work, because each
is just a VT host for the client. Nothing requires Windows Terminal, and Claude
Code documents no terminal requirement beyond a shell.

## Hooks

How Claude Code runs `type: "command"` hooks on Windows, per its docs: the command
string goes to Git Bash when Git for Windows is installed, otherwise to PowerShell;
the `shell` field can force `"powershell"`. Git for Windows is recommended but not
required. Hooks inherit the parent process environment. `async: true` is supported
and has no Windows restriction. The hook's stdin JSON carries `session_id`,
`transcript_path`, `cwd`, `permission_mode` and `hook_event_name`.

Design:

- The hook entry is written with `"shell": "powershell"` so it behaves the same
  with or without Git Bash, and the command is
  `& "<node.exe>" "<...>\bin\glancecode-hook.mjs"`, both paths absolute and taken
  from `process.execPath` and the package location at install time. `async: true`
  as upstream, and a short `timeout`.
- `glancecode-hook.mjs` reads stdin, posts it to `http://127.0.0.1:7718/hook`
  with headers `X-Host` and `X-Pane` (from `GLANCECODE_HOST`/`GLANCECODE_PANE`) and
  `X-Shell-Pid` (PowerShell's `$PID`, passed as an argument), swallows every
  error, and exits 0. Node starts in about 50 ms; PowerShell adds a few hundred.
  Both are hidden by `async`.
- **Process id of Claude.** Upstream's hook reports `$PPID`, which under
  `sh -c` is Claude itself. Under PowerShell → Node it is PowerShell. The hub
  doesn't need it for host sessions, because the host knows the ConPTY process
  and answers `alive`. For sessions started outside the host (view-only), the hub
  looks the parent up once, when a session first reports in, with
  `Get-CimInstance Win32_Process -Filter "ProcessId=<X-Shell-Pid>"` while that
  PowerShell is still alive, and retries on the next hook if it has already gone.
  One query per session, not per event. If that proves flaky, fall back to a
  transcript-mtime idle timeout for view-only sessions.
- `install` edits `%USERPROFILE%\.claude\settings.json` with the same
  merge/backup logic as upstream; `isOurHook` recognises the entry by the script's
  basename, so old paths are replaced on reinstall.
- The transcript path "is written asynchronously and may lag" (docs). Upstream
  already treats `Stop`'s `last_assistant_message` as the end-of-turn text and
  tails the file with a poll, so nothing new is needed; worth remembering when
  testing `confirmDelivered`.

## CLI on Windows

Same commands, same output. Differences:

| Command | Windows behaviour |
|---|---|
| `glancecode claude [args]` | starts the host if needed, creates a session, attaches. Inside a host session (`GLANCECODE_PANE` set) it just runs Claude Code, like upstream inside tmux. |
| `glancecode attach [name]`, `ls` | ask the host instead of `tmux list-sessions` |
| `glancecode service install\|uninstall\|restart\|status` | Task Scheduler, see below |
| `glancecode serve on\|off\|status` | `tailscale.exe serve --bg --https=7443 http://127.0.0.1:7717`, found on PATH or at `C:\Program Files\Tailscale\tailscale.exe` |
| `glancecode setup-voice` | downloads `whisper-bin-x64.zip` (or the arm64 build) from whisper.cpp's release and the model with Node's `fetch`, not `curl` |
| `glancecode doctor` | checks Node ≥ 20, Claude Code on PATH, Tailscale running with HTTPS certs, the host pipe, the hub, the hook in `settings.json`, the speech model and `whisper-server.exe` |
| `glancecode pair` | unchanged; the code is printed, and a QR is drawn in the terminal only if a pure-JS encoder is bundled later (`qrencode` isn't common on Windows) |

`commandExists` uses `where.exe`; `findRealClaude` filters this package's own npm
shim out of the `where.exe claude` results the same way upstream filters itself
out of `which -a claude`. The `bin/glancecode` entry gets a `.cmd` shim from npm
automatically, so `glancecode` works from PowerShell and cmd.

## Background service: Task Scheduler

`glancecode service install` writes a task XML and registers it with
`schtasks /Create /XML`, because the XML form is the only one that can ask for
restart on failure:

- Trigger: at logon of the current user. Principal: the current user, least
  privilege, "run only when user is logged on", so the hub shares the desktop
  session with your terminals and no password is stored.
- Action: `wscript.exe "%LOCALAPPDATA%\glancecode\hub-launcher.vbs"`, a three-line
  script that starts `node.exe <glancecode> hub` hidden. A console program started
  directly by a logon task gets a visible console window; this is the standard
  way around it.
- Settings: `RestartOnFailure` every minute, unlimited; `ExecutionTimeLimit` off;
  `MultipleInstancesPolicy` IgnoreNew; allowed on battery.
- Logs: the hub writes its own log to `%LOCALAPPDATA%\glancecode\logs\hub.log`,
  rotated at 5 MB, since there is no `StandardOutPath`.

`service install` also runs the task once so the hub is up immediately. `status`
reads `schtasks /Query /TN GlanceCode /V /FO LIST`. The hub keeps sessions across
its own restarts by asking the host for its session list at startup and matching
ids against `sessions.json`, so a hub restart never shows an empty glasses list.

Keeping the machine awake (`preventSleep`) uses
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` from a small
PowerShell child the hub keeps alive, only while on AC power. Later milestone.

## HTTPS and the phone

Unchanged: Tailscale on the PC and the phone, HTTPS certificates on for the
tailnet, `tailscale serve` proxying `https://<pc>.<tailnet>.ts.net:7443` to
`http://127.0.0.1:7717`. A port proxy needs no elevation on Windows (only file
serving does). `tailscale status --json` and `tailscale serve status --json` have
the same shape as on macOS, so `tailscaleStatus()` and `serveActive()` in
`bin/glancecode` port as they are.

The hub still binds 127.0.0.1 only. Loopback listeners don't trigger Windows
Firewall prompts.

## Voice

whisper.cpp publishes Windows binaries on its build-tagged releases (for example
`b5454`: `whisper-bin-x64.zip`, `whisper-bin-win-cpu-arm64.zip` and CUDA variants),
and the zip contains `whisper-server.exe`, the same HTTP server upstream talks
to. The version-tagged releases (`v1.9.x`) carry no binaries, so the code pins a
build tag. `setup-voice` downloads the zip for the machine's architecture into
`%LOCALAPPDATA%\glancecode\whisper\` and the `ggml-large-v3-turbo-q5_0.bin` model
into `%LOCALAPPDATA%\glancecode\models\`, both with resumable `fetch` to a `.part`
file, and unzips with PowerShell's `Expand-Archive` (no dependency). `hub/stt.mjs`
only changes the binary path (configurable as `whisperBin`) and spawns it with
`windowsHide: true`.

## Paths and config

| Upstream | Windows |
|---|---|
| `~/.config/glancecode/` (config.json, sessions.json, tmux.conf) | `%APPDATA%\glancecode\` (config.json, sessions.json) |
| `~/.local/share/glancecode/models/` | `%LOCALAPPDATA%\glancecode\models\`, plus `whisper\` and `logs\` |
| `~/.claude/settings.json`, `~/.claude/projects/` | `%USERPROFILE%\.claude\settings.json`, `%USERPROFILE%\.claude\projects\`. Same layout. The project folder is the cwd with every non-alphanumeric character replaced by `-` (documented), so `D:\Repos\foo` is `D--Repos-foo`; `cwd` inside entries keeps backslashes. `CLAUDE_CONFIG_DIR` is honoured when set. |
| `chmod 600 config.json` | skipped; the profile folders are already user-only |
| `GLANCECODE_CONFIG_DIR`, `GLANCECODE_DATA_DIR` | same overrides, used by tests and CI |

Config keys dropped: `tmuxSocket`, `codex*`, `gemini*`, `defaultAgent`. Added:
`whisperBin`, `hostPipe` (default derived from the username). Everything else
keeps its name and default.

Code that splits paths on `/` (`sessionNameFor` in `hub/tmux.mjs`) switches to
`path.basename`, which handles both separators on Windows.

## Code plan

The fork keeps upstream's file layout so merges from upstream stay tractable.

| File | Change |
|---|---|
| `host/host.mjs` (new) | the session host: pipe server, ConPTY sessions, headless screens, attach streams |
| `host/client.mjs` (new) | pipe client used by the hub and the CLI; the terminal relay for attach |
| `hub/tmux.mjs` → `hub/pane.mjs` | same exported functions (`capture`, `readDialog`, `sendPrompt`, `sendKey`, `chooseOption`, `switchModel`, `answerWithText`, `launchClaude`, `acceptTrustIfShown`, `waitForInput`, `paneAlive`, `paneKey`, …) over the host client. `readDialog`, `promptSnippet`, `screenHasSnippet` and `switchModel`'s logic are copied unchanged; they only look at text. |
| `hub/sessions.mjs` | imports from `pane.mjs`; hook env fields become `host`/`pane`/`shellPid`; Gemini branches removed; `pidAlive` works as is (`process.kill(pid, 0)` is supported on Windows) |
| `hub/server.mjs` | Codex and Gemini removed; `caffeinate` behind a platform check; a file logger; everything else as is |
| `hub/config.mjs` | Windows directories, dropped and added keys, no `chmod` |
| `hub/stt.mjs` | binary path, `windowsHide` |
| `bin/glancecode` | `where.exe`, Task Scheduler service, host-based `claude`/`attach`/`ls`, `fetch` download, Codex/Gemini commands removed |
| `bin/glancecode-hook.mjs` (new, replaces the bash script) | see Hooks |
| `package.json` | `"os": ["win32"]`; `host/` in `files`; dependencies `@lydell/node-pty`, `@xterm/headless`, `@xterm/addon-serialize` |
| `test/` | `transcript.test.mjs` kept; `codex`/`gemini` tests dropped; new tests for the host protocol and `pane.mjs` against a fake host; CI matrix on `windows-latest` |
| `app/` | unchanged, except the "not in tmux" help text in `app/src/app.ts`, which already reads the agent from the hub and can say "start it with `glancecode claude`" |
| docs | README rewritten for Windows; this file |

### On dependencies

Upstream's hub has no runtime dependencies and CONTRIBUTING asks to keep it so.
This fork needs two, and both live in the host, not the hub:

- `@lydell/node-pty`: ConPTY bindings with prebuilt binaries for win32-x64 and
  win32-arm64 as optional dependencies, so `npm install -g` needs no compiler.
  There is no way to create a pseudo-console from plain Node.
- `@xterm/headless` (+ `@xterm/addon-serialize`): a VT parser with a screen
  buffer, needed to answer "what does the screen say" without a terminal window.
  Writing a VT parser good enough for Claude Code's Ink UI by hand isn't worth it.

The hub itself stays dependency-free; it only speaks JSON over a pipe.

## Keeping up with upstream

Remotes: `upstream` → `sousyllc/glancecode`, `origin` → the fork. The fork is a
divergent port, not a feature branch, so upstream changes come over by cherry-pick
or small merges rather than rebases. Upstream commits to `hub/transcript.mjs`,
`hub/sessions.mjs`, `hub/server.mjs` and `app/` apply almost directly; changes to
`hub/tmux.mjs` and `bin/glancecode` get translated by hand. Wire-level names the
app depends on (`tmuxName`, `controllable`, `origin`) stay as they are so the same
store app serves both hubs.

If the port proves solid, the clean end state is to offer upstream a `hub/pane.mjs`
abstraction with a tmux backend and a host backend, and keep Windows support in
one tree. That's a later conversation with upstream.

## Milestones

1. **Host and local control.** `host/`, `pane.mjs`, `glancecode claude`/`attach`/
   `ls`; the hub follows hook-registered sessions and can type into them.
   Verified by: start a session at the desk, send a prompt with `curl` to the hub
   API, see it typed; approve a permission; interrupt.
2. **Install story.** Node hook script, `install`/`uninstall`, Task Scheduler
   service, `serve`, `pair`, `doctor`, Windows config paths. Pair real glasses.
3. **Voice.** `setup-voice` downloading whisper.cpp's Windows build and the
   model; hold to talk end to end.
4. **Polish.** Keep-awake, hub re-adopting host sessions after a restart, QR code
   in the terminal, an ARM64 check on a Snapdragon machine, CI on
   `windows-latest`. Possibly: deliver prompts to view-only sessions through
   Claude Code's cross-session messaging pipe (documented; prompts only, never
   approvals).

## Risks and open questions

- **ConPTY output shape.** ConPTY re-renders rather than passing the app's exact
  bytes through, so the headless screen shows what a terminal would show, which
  is what `readDialog` wants. Cursor-position and partial-redraw quirks may need
  the same tolerance tmux's `-J` join gave upstream; `readDialog` already trims
  and joins.
- **Hook shell.** Forcing `"shell": "powershell"` relies on that field; it is in
  the hooks docs and already in use in this machine's settings. If it ever went
  away, the fallback is a command that works in both bash and PowerShell, which
  is awkward because of `&`.
- **Claude's PID for view-only sessions.** One CIM query per new session, racing
  the PowerShell exit. Mitigation above.
- **`claude.cmd` argument quoting** through `cmd.exe /c` for prompts with quotes
  or carets. The host passes an argv array to node-pty, which builds the command
  line, and prefers the native `claude.exe`, which avoids `cmd.exe` entirely.
- **Defender / SmartScreen** on a downloaded `whisper-server.exe`: it is unsigned.
  Running it from `%LOCALAPPDATA%` normally just works; `doctor` should notice if
  the process exits at once and point at the Defender history.
- **Named pipe collisions** between two users on the same PC are avoided by the
  username in the pipe name; a fast-user-switched second desktop gets its own
  host.
- **Node ABI.** `@lydell/node-pty` prebuilds must cover the Node version in use
  (this machine runs Node 24); confirm at implementation and set `engines`
  accordingly.

## What milestone 1 found

Things the implementation learned that the design above didn't predict:

- **Arrow keys don't reach Claude Code's menus through ConPTY.** A raw-mode Node
  program inside the same ConPTY receives `ESC [ B` fine, in legacy, application
  and win32-input-mode encodings, but Claude Code's select menus (trust dialog,
  model picker) don't move. The vi keys `j`/`k` do. The host exposes them as
  `MenuDown`/`MenuUp`, and the trust handler checks that "Yes, I trust" has the
  focus before pressing Enter. Only menus use them; in the prompt box they'd type.
- **A lone Escape is delayed.** conhost holds a bare ESC on the input pipe waiting
  for a sequence, about a second. Sent as a win32-input-mode key record
  (`ESC [ 27;1;27;1;0;1 _` down, then up) it is delivered at once, so `Escape` in
  the key table is that record. Interrupt from the API works with it.
- **node-pty leaves handles open after a natural exit.** Only the output pipe is
  closed when the child exits on its own; the input pipe and the conout worker
  stay. The host calls the pty's `kill()` after exit to release them, or the host
  process never ends.
- **Nested-session markers.** A hub started from inside a Claude Code session
  passes `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID` and
  friends to the host, and Claude Code then treats the new session as a child:
  transcript saving off, so the hub saw no items. The host strips them.
- **The Claude pid of a view-only session** must be looked up while the hook's
  PowerShell is still alive, which is only until the hub answers the POST. The
  hub does the one CIM query before replying to a new view-only session's first
  hook. Verified: a session started outside the host is listed view-only and is
  marked ended within one sweep after its process dies.
- **A killed hub tree takes the host with it.** The host is spawned detached, so
  closing a console window leaves it alone, but anything that kills the hub's
  process tree (`taskkill /T`, and possibly Task Scheduler's end-task) kills the
  host and orphans its Claude processes. Milestone 2 should start the host through
  an intermediate (`wscript`, `Start-Process`) so it isn't the hub's child, and
  the host should notice its ConPTY children on startup.
- **Host idleness** counts only sessions, not control connections: the hub keeps
  one open for as long as it runs, and a host with nothing to hold should make way
  for a newer one.
- The hook entry is `& "<node.exe>" "<...>\glancecode-hook.mjs" $PID` with
  `"shell": "powershell"`, `async: true`, `timeout: 10`. For testing without
  touching `%USERPROFILE%\.claude\settings.json`, the same entry in a scratch
  project's `.claude\settings.json` works.

## What milestone 2 found

- **Task Scheduler and process trees.** The task's action is `wscript.exe` running
  a script that starts the hub hidden and waits for it, so Task Scheduler sees the
  hub's exit code and restarts it on failure. `schtasks /End` plus stopping the hub
  process does not reach the host when the host was started through its own
  non-waiting `wscript` launcher: after `service stop` the host and its Claude
  session were still there, and the restarted hub listed the session as
  controllable again from `sessions.json`. The job-object worry in the design
  didn't materialise.
- The task runs with the interactive token and least privilege, no stored
  password; `Get-ScheduledTask` through PowerShell gives a locale-independent
  status.
- Tailscale on this machine installs to `C:\Program Files\Tailscale` without
  adding itself to PATH, so the CLI looks there. HTTPS certificates are a tailnet
  setting the user has to flip once in the admin console; `serve` says so.
