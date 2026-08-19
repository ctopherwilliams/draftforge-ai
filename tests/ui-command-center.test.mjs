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
  assert.match(page, /Live board #\{displayLiveBoardRank \|\| "—"\}/);
  assert.match(page, /resolveActionSurfaceStatus/);
  assert.doesNotMatch(page, /Consensus #\{displayConsensusRank/);
  assert.doesNotMatch(page, /context\.onClock \? "ESPN clock too short/);
  assert.match(page, /resolveEspnNominatedPlayer\(recommendations, context\)/);
  assert.doesNotMatch(page, /league\.draftType === "AUCTION" && context\.onClock && auctionNomination/);
  assert.match(page, /function displayAuctionValue/);
  assert.match(page, /displayAuctionValue\(player\.id, league\.id, player\.fairValue\)/);
  assert.doesNotMatch(page, /displayAuctionValue\(player\.id, league\.id, player\.auction\)/);
  assert.match(page, /draftAuditPendingRef/);
  assert.match(page, /DRAFT_AUDIT_RECORDED/);
  assert.match(page, /ESPN roster confirmed/);
  assert.match(page, /rosterComplete: myPickCount >= league\.rosterSize/);
  assert.match(page, /attempt < 3/);
  assert.equal((page.match(/className="on-clock-card panel"/g) || []).length, 1, "connection status must render once");
});

test("command-center styles preserve readable and responsive controls", () => {
  assert.match(css, /html\s*\{[^}]*font-size:\s*16px/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /grid-template-areas:\s*"coach players roster"/);
  assert.match(css, /grid-template-areas:\s*"coach roster"\s*"players roster"/);
  assert.match(css, /grid-template-areas: "coach" "roster" "players"/);
  assert.match(css, /\.player-list \{[^}]*max-height:\s*390px/s);
  assert.match(css, /\.completion-hero \.rec-player h2 \{[^}]*white-space:\s*normal/s);
  assert.match(css, /\.workspace \{[^}]*max-width:\s*none/s);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.settings-button::after, \.auto-toggle::after \{ content: none/);
  assert.match(css, /\.app-shell:has\(\.setup-drawer\) \.topbar \{ position: relative; \}/);
  assert.match(css, /--blue:\s*#49b6ff/);
  assert.doesNotMatch(css, /--green|#4ee0a1|#6af2b6|#c5ff45|#9ed01b|#24a66e|#23b77b/i);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[0-3])px/);
});
