// Claude Code hook -> glancecode hub. Registered as an async PowerShell hook:
//   & "node.exe" "...\glancecode-hook.mjs" $PID
// It forwards the hook's JSON to the hub with where it ran (the host pane, from the
// environment the host gave Claude Code) and PowerShell's pid, whose parent is Claude.
// It always exits 0 and swallows every error, so a stopped hub is harmless.
const port = process.env.GLANCECODE_HOOK_PORT || "7718";
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  try {
    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Host": process.env.GLANCECODE_HOST || "",
        "X-Pane": process.env.GLANCECODE_PANE || "",
        "X-Shell-Pid": process.argv[2] || "",
      },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* hub not running */
  }
  process.exit(0);
});
process.stdin.on("error", () => process.exit(0));
setTimeout(() => process.exit(0), 4000).unref();
