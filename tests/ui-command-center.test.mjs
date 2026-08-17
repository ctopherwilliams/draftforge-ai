import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, css, presentation] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/draft-command.css", import.meta.url), "utf8"),
  readFile(new URL("../app/lib/draft-presentation.ts", import.meta.url), "utf8"),
]);

test("live decision precedes secondary player-board detail", () => {
  const decision = page.indexOf('className="coach-column"');
  const roster = page.indexOf('className="roster-panel panel"');
  const playerBoard = page.indexOf('className="players-panel panel"');
  assert.ok(decision > 0, "command center decision should render");
  assert.ok(roster > decision, "roster control should follow the decision");
  assert.ok(playerBoard > roster, "player board should be secondary in reading order");
  assert.match(presentation, /LOCKED — COMPLETE CHECKLIST/);
  assert.match(presentation, /PASS — CEILING/);
  assert.match(page, /Protected reserve/);
  assert.match(page, /\$1 per open slot/);
  assert.match(page, /Preview the command center/);
  assert.match(page, /previewDraftFormat\("AUCTION"\)/);
  assert.match(page, /Spendable runway/);
  assert.match(page, /untouchable reserve/);
  assert.match(page, /PREFLIGHT 1 OF 2/);
  assert.match(page, /displayCommandLabel/);
});

test("command-center styles preserve readable and responsive controls", () => {
  assert.match(css, /html\s*\{[^}]*font-size:\s*16px/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /grid-template-areas:\s*"coach players roster"/);
  assert.match(css, /grid-template-areas:\s*"coach roster"\s*"players roster"/);
  assert.match(css, /grid-template-areas: "coach" "roster" "players"/);
  assert.match(css, /\.player-list \{[^}]*max-height:\s*390px/s);
  assert.match(css, /\.workspace \{[^}]*max-width:\s*none/s);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.settings-button::after, \.auto-toggle::after \{ content: none/);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[0-3])px/);
});
