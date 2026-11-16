"use strict";

const crypto = require("crypto");
const { execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const DEFAULT_URL =
  "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z";
const WIN_CODE_SIGN_DIR_NAME = "winCodeSign-2.6.0";
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 60000;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

function resolveCacheRoot(env = process.env, homedir = os.homedir()) {
  if (env && env.ELECTRON_BUILDER_CACHE) {
    return env.ELECTRON_BUILDER_CACHE;
  }
  const localAppData = (env && env.LOCALAPPDATA) || path.join(homedir, "AppData", "Local");
  return path.join(localAppData, "electron-builder", "Cache");
}

function isAlreadyCached(targetDir) {
  return (
    fs.existsSync(path.join(targetDir, "rcedit-x64.exe")) ||
    fs.existsSync(path.join(targetDir, "windows-10", "x64", "rcedit-x64.exe"))
  );
}

function downloadFile(url, destPath, options = {}) {
  const maxRedirects = options.maxRedirects !== undefined ? options.maxRedirects : MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;

    function fail(err) {
      if (settled) {
        return;
      }
      settled = true;
      fs.rmSync(destPath, { force: true });
      reject(err);
    }

    function requestUrl(currentUrl, redirectsRemaining) {
      let parsedUrl;
      try {
        parsedUrl = new URL(currentUrl);
      } catch (err) {
        fail(new Error(`Invalid download URL "${currentUrl}": ${err.message}`));
        return;
      }

      const client = parsedUrl.protocol === "http:" ? http : parsedUrl.protocol === "https:" ? https : null;
      if (!client) {
        fail(new Error(`Unsupported URL protocol "${parsedUrl.protocol}" for "${currentUrl}"`));
        return;
      }

      const req = client.get(parsedUrl, { headers: { "User-Agent": "elevate-prepare-wincodesign" } }, (res) => {
        const statusCode = res.statusCode || 0;

        if (REDIRECT_STATUS_CODES.has(statusCode)) {
          const location = res.headers.location;
          res.resume();
          if (!location) {
            fail(new Error(`HTTP ${statusCode} redirect missing Location header from ${currentUrl}`));
            return;
          }
          if (redirectsRemaining <= 0) {
            fail(new Error(`Exceeded maximum redirects (${maxRedirects}) while downloading ${url}`));
            return;
          }
          const nextUrl = new URL(location, currentUrl).toString();
          requestUrl(nextUrl, redirectsRemaining - 1);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          fail(new Error(`Failed to download ${currentUrl}: HTTP ${statusCode} ${res.statusMessage || ""}`.trim()));
          return;
        }

        const fileStream = fs.createWriteStream(destPath);
        fileStream.on("error", (err) => {
          res.destroy();
          fail(new Error(`Failed to write ${destPath}: ${err.message}`));
        });
        res.on("error", (err) => {
          fileStream.destroy();
          fail(new Error(`Download stream error from ${currentUrl}: ${err.message}`));
        });
        fileStream.on("finish", () => {
          fileStream.close((closeErr) => {
            if (closeErr) {
              fail(new Error(`Failed to close ${destPath}: ${closeErr.message}`));
              return;
            }
            if (!settled) {
              settled = true;
              resolve(destPath);
            }
          });
        });

        res.pipe(fileStream);
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Download timed out after ${timeoutMs}ms: ${currentUrl}`));
      });

      req.on("error", (err) => {
        fail(new Error(`HTTP request failed for ${currentUrl}: ${err.message}`));
      });
    }

    requestUrl(url, maxRedirects);
  });
}

function run7za(path7za, args) {
  return new Promise((resolve, reject) => {
    execFile(path7za, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const details = [stderr, stdout].filter(Boolean).join("\n").trim();
        reject(
          new Error(
            `7za extraction failed (${err.code !== undefined ? `exit ${err.code}` : err.message})${details ? `:\n${details}` : ""}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function prepareWinCodeSign(options = {}) {
  const platform = options.platform !== undefined ? options.platform : process.platform;
  if (platform !== "win32") {
    return { skipped: true, reason: "non-win32" };
  }

  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const cacheRoot = resolveCacheRoot(env, homedir);
  const winCodeSignDir = path.join(cacheRoot, "winCodeSign");
  const targetDir = path.join(winCodeSignDir, WIN_CODE_SIGN_DIR_NAME);

  if (isAlreadyCached(targetDir)) {
    return { skipped: true, reason: "already-cached", targetDir };
  }

  fs.mkdirSync(winCodeSignDir, { recursive: true });

  const uniqueSuffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const archivePath = path.join(winCodeSignDir, `.tmp-${WIN_CODE_SIGN_DIR_NAME}-${uniqueSuffix}.7z`);
  const tempExtractDir = path.join(winCodeSignDir, `.tmp-${WIN_CODE_SIGN_DIR_NAME}-${uniqueSuffix}`);
  const url = options.url || DEFAULT_URL;
  const path7za = options.path7za || require("7zip-bin").path7za;

  try {
    await downloadFile(url, archivePath, {
      maxRedirects: options.maxRedirects,
      timeoutMs: options.timeoutMs,
    });

    fs.mkdirSync(tempExtractDir, { recursive: true });
    await run7za(path7za, ["x", "-bd", "-y", "-xr!darwin", archivePath, `-o${tempExtractDir}`]);

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.renameSync(tempExtractDir, targetDir);

    return { skipped: false, targetDir };
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  prepareWinCodeSign()
    .then((result) => {
      if (result.skipped) {
        console.log(
          `[prepare-wincodesign] Skipped (${result.reason})${result.targetDir ? `: ${result.targetDir}` : ""}`
        );
      } else {
        console.log(`[prepare-wincodesign] Prepared winCodeSign-2.6.0 at ${result.targetDir}`);
      }
    })
    .catch((err) => {
      console.error(`[prepare-wincodesign] Error: ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_URL,
  prepareWinCodeSign,
  resolveCacheRoot,
};
