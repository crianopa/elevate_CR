"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { path7za } = require("7zip-bin");
const { prepareWinCodeSign, resolveCacheRoot } = require("./prepare-wincodesign");

function resolveTest7za() {
  try {
    fs.accessSync(path7za, fs.constants.X_OK);
    return path7za;
  } catch {
    return "7za";
  }
}

test("skips on non-win32 platforms", async () => {
  const linuxResult = await prepareWinCodeSign({ platform: "linux" });
  assert.deepEqual(linuxResult, { skipped: true, reason: "non-win32" });

  const darwinResult = await prepareWinCodeSign({ platform: "darwin" });
  assert.deepEqual(darwinResult, { skipped: true, reason: "non-win32" });
});

test("resolves cache root from ELECTRON_BUILDER_CACHE or LOCALAPPDATA fallback", () => {
  const customCache = path.join("C:", "custom-eb-cache");
  assert.equal(
    resolveCacheRoot({ ELECTRON_BUILDER_CACHE: customCache, LOCALAPPDATA: "C:\\Ignored" }, "C:\\Users\\Test"),
    customCache
  );

  const localAppData = path.join("C:", "Users", "Test", "AppData", "Local");
  assert.equal(
    resolveCacheRoot({ LOCALAPPDATA: localAppData }, "C:\\Users\\Ignored"),
    path.join(localAppData, "electron-builder", "Cache")
  );

  const homedir = path.join("C:", "Users", "Fallback");
  assert.equal(
    resolveCacheRoot({}, homedir),
    path.join(homedir, "AppData", "Local", "electron-builder", "Cache")
  );
});

test("skips when winCodeSign-2.6.0 is already cached", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-wcs-cached-"));
  try {
    const cacheRoot = path.join(tmpRoot, "cache");
    const targetDir = path.join(cacheRoot, "winCodeSign", "winCodeSign-2.6.0");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "rcedit-x64.exe"), "stub-rcedit");

    const result = await prepareWinCodeSign({
      platform: "win32",
      env: { ELECTRON_BUILDER_CACHE: cacheRoot },
      url: "http://127.0.0.1:1/should-not-be-called",
    });

    assert.deepEqual(result, {
      skipped: true,
      reason: "already-cached",
      targetDir,
    });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("downloads over HTTP 302 redirect and extracts with 7za -xr!darwin excluding darwin symlinks", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-wcs-extract-"));
  const test7za = resolveTest7za();
  let server;

  try {
    const sourceDir = path.join(tmpRoot, "archive-src");
    const winDir = path.join(sourceDir, "windows-10", "x64");
    const darwinLibDir = path.join(sourceDir, "darwin", "10.12", "lib");
    fs.mkdirSync(winDir, { recursive: true });
    fs.mkdirSync(darwinLibDir, { recursive: true });

    const expectedContent = "dummy-rcedit-x64-binary";
    fs.writeFileSync(path.join(winDir, "rcedit-x64.exe"), expectedContent);
    fs.writeFileSync(path.join(sourceDir, "rcedit-x64.exe"), expectedContent);
    fs.symlinkSync("libcrypto.1.0.0.dylib", path.join(darwinLibDir, "libcrypto.dylib"));

    const archivePath = path.join(tmpRoot, "winCodeSign-2.6.0.7z");
    execFileSync(test7za, ["a", "-snl", archivePath, "."], { cwd: sourceDir, stdio: "pipe" });
    const archiveBuffer = fs.readFileSync(archivePath);

    server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/download/winCodeSign-2.6.0.7z" });
        res.end();
        return;
      }
      if (req.url === "/download/winCodeSign-2.6.0.7z") {
        res.writeHead(200, {
          "Content-Type": "application/x-7z-compressed",
          "Content-Length": archiveBuffer.length,
        });
        res.end(archiveBuffer);
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const cacheRoot = path.join(tmpRoot, "eb-cache");
    const result = await prepareWinCodeSign({
      platform: "win32",
      env: { ELECTRON_BUILDER_CACHE: cacheRoot },
      url: `http://127.0.0.1:${port}/redirect`,
      path7za: test7za,
    });

    const expectedTargetDir = path.join(cacheRoot, "winCodeSign", "winCodeSign-2.6.0");
    assert.deepEqual(result, {
      skipped: false,
      targetDir: expectedTargetDir,
    });

    assert.equal(
      fs.readFileSync(path.join(expectedTargetDir, "windows-10", "x64", "rcedit-x64.exe"), "utf8"),
      expectedContent
    );
    assert.equal(fs.existsSync(path.join(expectedTargetDir, "darwin")), false);

    const remainingEntries = fs.readdirSync(path.join(cacheRoot, "winCodeSign"));
    assert.deepEqual(remainingEntries, ["winCodeSign-2.6.0"]);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("rejects on non-2xx HTTP status and cleans up temp files", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-wcs-http-err-"));
  let server;

  try {
    server = http.createServer((_req, res) => {
      res.writeHead(404, "Not Found");
      res.end("missing");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const cacheRoot = path.join(tmpRoot, "eb-cache");
    await assert.rejects(
      () =>
        prepareWinCodeSign({
          platform: "win32",
          env: { ELECTRON_BUILDER_CACHE: cacheRoot },
          url: `http://127.0.0.1:${port}/missing.7z`,
          path7za,
        }),
      /HTTP 404/
    );

    const winCodeSignDir = path.join(cacheRoot, "winCodeSign");
    assert.deepEqual(fs.readdirSync(winCodeSignDir), []);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
