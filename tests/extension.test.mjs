import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../extension/", import.meta.url);

test("extension is a narrowly scoped Manifest V3 ESPN companion", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.host_permissions.every((host) => /espn\.com/.test(host)));
  assert.ok(manifest.content_scripts.some((script) => script.matches.includes("https://fantasy.espn.com/*")));
});

test("draft actions fail closed and private ESPN credentials are not persisted", async () => {
  const [background, content] = await Promise.all([
    readFile(new URL("background.js", root), "utf8"),
    readFile(new URL("espn-content.js", root), "utf8"),
  ]);
  assert.doesNotMatch(background, /chrome\.storage|espn_s2|SWID/);
  assert.match(content, /NOT_ON_CLOCK/);
  assert.match(content, /WRONG_LEAGUE/);
  assert.match(content, /NOMINEE_MISMATCH/);
  assert.match(content, /ACTION_NOT_FOUND/);
  assert.match(content, /requireOnClock/);
});
