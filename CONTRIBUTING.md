# Contributing

This is a private, Windows-native fork of [GlanceCode](https://github.com/sousyllc/glancecode).
See `docs/windows-design.md` for what changed and why.

## Setup

```powershell
git clone <this repo>
cd wglancecode
npm install
npm run build:app
npm test
```

Run the hub from the checkout with `node bin/glancecode hub`. To keep a development
hub apart from an installed one, set `GLANCECODE_CONFIG_DIR`, `GLANCECODE_DATA_DIR` and
`GLANCECODE_HOST_PIPE` to scratch values and use different ports in that config.

Claude Code also reads hooks from a project's own `.claude/settings.json`, so a
scratch project folder with the hook in it lets you test the hub without touching
your user settings.

## Testing the glasses app without glasses

```powershell
cd app; npx vite --host 127.0.0.1
npx @evenrealities/evenhub-simulator --automation-port 9898 "http://127.0.0.1:5173/?demo"
```

The simulator's automation API takes input and screenshots:

```powershell
curl.exe -X POST 127.0.0.1:9898/api/input -H "Content-Type: application/json" -d "{\"action\":\"click\"}"
curl.exe -o shot.png 127.0.0.1:9898/api/screenshot/glasses
```

Screenshots are RGBA with a transparent background. Composite them onto black
to view them.

## Guidelines

- The hub has no runtime dependencies. The two the fork needs (`@lydell/node-pty`
  for ConPTY and `@xterm/headless` for the screen buffer) live in `host/` only.
- Anything that presses keys in a session must first confirm the expected dialog
  is on screen.
- Test against a real Claude Code session in a scratch folder with a scratch
  config dir and host pipe, and never run `/model` against your real settings in
  a test.
- Glasses text must fit the 576×288 display. Use the helpers in `app/src/text.ts`.
