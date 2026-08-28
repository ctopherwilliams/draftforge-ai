#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, renameSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  computeExtensionDirectoryIntegrity,
  computeExtensionZipIntegrity,
} from "./release-integrity-lib.mjs";

const extensionDir = resolve("extension");
const output = resolve("public/draftforge-espn-companion.zip");
const directory = computeExtensionDirectoryIntegrity(extensionDir);
const files = directory.files.map((file) => file.path);
const staging = mkdtempSync(join(tmpdir(), "draftforge-extension-"));
const stagedZip = join(staging, "draftforge-espn-companion.zip");
const fixedTimestamp = new Date("2026-01-01T00:00:00.000Z");

try {
  if (!files.includes("manifest.json") || !files.includes("background.js") || !files.includes("espn-content.js")) {
    throw new Error("extension package is missing a required companion file");
  }
  for (const file of files) {
    const target = join(staging, basename(file));
    copyFileSync(join(extensionDir, file), target);
    chmodSync(target, 0o644);
    utimesSync(target, fixedTimestamp, fixedTimestamp);
  }
  execFileSync("/usr/bin/zip", ["-X", "-q", stagedZip, ...files], { cwd: staging });
  renameSync(stagedZip, output);
  const archive = computeExtensionZipIntegrity(output);
  if (directory.sha256 !== archive.sha256
    || directory.fileCount !== archive.fileCount
    || directory.files.some((file, index) => {
      const packaged = archive.files[index];
      return packaged?.path !== file.path || packaged.bytes !== file.bytes || packaged.sha256 !== file.sha256;
    })) {
    throw new Error("extension package bytes do not exactly match the source directory");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output,
    files: archive.fileCount,
    sha256: archive.packageSha256,
    sourceSha256: archive.sha256,
  })}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
