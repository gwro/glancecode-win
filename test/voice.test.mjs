import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, formatProgress, whisperAsset, whisperAssetUrl, WHISPER_BUILD } from "../hub/voice.mjs";

test("whisper.cpp asset is picked by CPU architecture", () => {
  assert.equal(whisperAsset("x64"), "whisper-bin-x64.zip");
  assert.equal(whisperAsset("arm64"), "whisper-bin-win-cpu-arm64.zip");
  assert.equal(whisperAsset("ia32"), null);
  assert.equal(whisperAsset("x64", { cuda: true }), "whisper-bin-win-cuda-12.4.0-x64.zip");
  assert.equal(whisperAsset("arm64", { cuda: true }), "whisper-bin-win-cpu-arm64.zip", "no CUDA build for arm64");
  assert.match(whisperAssetUrl("x64"), new RegExp(`/releases/download/${WHISPER_BUILD}/whisper-bin-x64\\.zip$`));
  assert.equal(formatProgress(123456789, 550000000), "123 / 550 MB (22%)");
  assert.equal(formatProgress(5e6, null), "5 MB");
});

/** A file server that honours Range requests, like GitHub and Hugging Face do. */
function serve(body, { ranges = true } = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.headers.range || "");
    const m = ranges && /^bytes=(\d+)-$/.exec(req.headers.range || "");
    if (m) {
      const from = Number(m[1]);
      if (from >= body.length) return res.writeHead(416).end();
      res.writeHead(206, { "Content-Length": body.length - from, "Content-Range": `bytes ${from}-${body.length - 1}/${body.length}` });
      return res.end(body.subarray(from));
    }
    res.writeHead(200, { "Content-Length": body.length });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}/file.bin` })));
}

test("downloadFile resumes a partial download and reports progress", async () => {
  const body = Buffer.alloc(200_000);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const { server, hits, url } = await serve(body);
  try {
    const dir = mkdtempSync(join(tmpdir(), "glancecode-dl-"));
    const dest = join(dir, "file.bin");
    writeFileSync(dest + ".part", body.subarray(0, 70_000)); // an interrupted earlier attempt
    const reports = [];
    await downloadFile(url, dest, { onProgress: (done, total) => reports.push([done, total]) });
    assert.deepEqual(readFileSync(dest), body, "the resumed file is whole and correct");
    assert.equal(hits[0], "bytes=70000-", "asks for the rest");
    assert.deepEqual(reports.at(-1), [200_000, 200_000]);
  } finally {
    server.close();
  }
});

test("downloadFile starts over when the server ignores the range", async () => {
  const body = Buffer.from("x".repeat(50_000));
  const { server, url } = await serve(body, { ranges: false });
  try {
    const dir = mkdtempSync(join(tmpdir(), "glancecode-dl-"));
    const dest = join(dir, "file.bin");
    writeFileSync(dest + ".part", "garbage");
    await downloadFile(url, dest);
    assert.deepEqual(readFileSync(dest), body);
  } finally {
    server.close();
  }
});
