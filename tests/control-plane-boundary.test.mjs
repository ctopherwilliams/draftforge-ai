import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function runtimeFiles(relativeDirectory) {
  const directory = new URL(relativeDirectory, projectRoot);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}${entry.name}`;
    if (entry.isDirectory()) files.push(...await runtimeFiles(`${relativePath}/`));
    else if (/\.(?:js|mjs|ts|tsx)$/.test(entry.name)) files.push(relativePath);
  }
  return files;
}

test("production control plane has no Codex browser-controller, CDP, or remote-debugging dependency", async () => {
  const files = [
    ...await runtimeFiles("app/"),
    ...await runtimeFiles("extension/"),
  ];
  const forbidden = [
    "setupBrowserRuntime",
    "mcp__node_repl",
    "chrome.debugger",
    "remote-debugging-port",
    "com.openai.codexextension",
    "computer-use",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, projectRoot), "utf8");
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} must not depend on ${token}`);
    }
  }

  const manifest = JSON.parse(await readFile(new URL("extension/manifest.json", projectRoot), "utf8"));
  assert.deepEqual([...manifest.permissions].sort(), ["storage", "tabs"]);
  assert.equal(manifest.permissions.includes("debugger"), false);

  const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
  const productionPackages = Object.keys(packageJson.dependencies || {});
  for (const dependency of ["playwright", "puppeteer", "chrome-remote-interface"]) {
    assert.equal(productionPackages.includes(dependency), false, `${dependency} cannot enter production dependencies`);
  }
});

test("external observers remain read-only while loopback and ESPN retain disjoint roles", async () => {
  const { authorizeRuntimeMessage } = await import("../extension/origin-policy.js");
  const observer = "https://draftforge-ai.workspace-231977.chatgpt.site/draft";
  const loopback = "http://127.0.0.1:3000/";
  const espn = "https://fantasy.espn.com/football/draft?leagueId=44050";

  for (const type of [
    "CONNECT_ESPN",
    "ARM_LIVE_ROOM_WATCH",
    "RECOVER_LIVE_WORKSPACE",
    "CANCEL_PENDING_ACTIONS",
    "WRITER_HEARTBEAT",
    "SUBMIT_ACTION",
  ]) {
    assert.deepEqual(authorizeRuntimeMessage(type, observer), {
      ok: false,
      code: "APP_WRITER_ORIGIN_REQUIRED",
    });
    assert.equal(authorizeRuntimeMessage(type, loopback).ok, true);
  }
  assert.equal(authorizeRuntimeMessage("ESPN_CONTEXT", espn).ok, true);
  assert.equal(authorizeRuntimeMessage("ESPN_CONTEXT", loopback).ok, false);
});
