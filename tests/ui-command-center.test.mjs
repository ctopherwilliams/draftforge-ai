import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, css] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/draft-command.css", import.meta.url), "utf8"),
]);

test("live decision precedes secondary player-board detail", () => {
  const decision = page.indexOf('className="coach-column"');
  const roster = page.indexOf('className="roster-panel panel"');
  const playerBoard = page.indexOf('className="players-panel panel"');
  assert.ok(decision > 0, "command center decision should render");
  assert.ok(roster > decision, "roster control should follow the decision");
  assert.ok(playerBoard > roster, "player board should be secondary in reading order");
  assert.match(page, /LOCKED — COMPLETE CHECKLIST/);
  assert.match(page, /PASS — CEILING/);
  assert.match(page, /Protected reserve/);
  assert.match(page, /\$1 per open slot/);
});

test("command-center styles preserve readable and responsive controls", () => {
  assert.match(css, /html \{ font-size: 16px; \}/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /grid-template-areas:\s*"coach roster"\s*"players roster"/);
  assert.match(css, /grid-template-areas: "coach" "roster" "players"/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.auto-toggle::after \{ content: none; \}/);
  assert.match(css, /\.settings-button::after \{ content: none; \}/);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[0-3])px/);
});
