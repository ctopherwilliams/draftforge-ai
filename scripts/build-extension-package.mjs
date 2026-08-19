#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const extensionDir = resolve("extension");
const output = resolve("public/draftforge-espn-companion.zip");
const staging = mkdtempSync(join(tmpdir(), "draftforge-extension-"));
const stagedZip = join(staging, "draftforge-espn-companion.zip");
const fixedTimestamp = new Date("2026-01-01T00:00:00.000Z");

try {
  const files = readdirSync(extensionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
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
  const sha256 = createHash("sha256").update(readFileSync(output)).digest("hex");
  process.stdout.write(`${JSON.stringify({ ok: true, output, files: files.length, sha256 })}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
