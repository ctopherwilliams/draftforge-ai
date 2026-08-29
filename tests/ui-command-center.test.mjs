import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { terminateProfileProcesses } from "../scripts/lib/exact-profile-process-cleanup.mjs";

const [page, css, presentation, auditPublisher, visualCertification, layout, packageText] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/draft-command.css", import.meta.url), "utf8"),
  readFile(new URL("../app/lib/draft-presentation.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/lib/draft-audit-publisher.ts", import.meta.url), "utf8"),
  readFile(new URL("../scripts/ui-visual-certification.mjs", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
]);
const packageManifest = JSON.parse(packageText);

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
  assert.match(page, /draftAuditPublisherRef/);
  assert.match(page, /const DASHBOARD_LOADED_AT = new Date\(\)\.toISOString\(\)/);
  assert.match(page, /dashboardLoadedAt: DASHBOARD_LOADED_AT/);
  assert.match(auditPublisher, /DRAFT_AUDIT_RECORDED/);
  assert.match(page, /isAuthorized\(publisherBinding/);
  assert.match(page, /exact decision audit acknowledgment/);
  assert.ok(
    page.indexOf("waitUntilAuthorized(") < page.indexOf('sendToExtension("SUBMIT_ACTION"'),
    "every ESPN action must wait for its exact recorded decision",
  );
  assert.match(page, /POST_AUDIT_CONTEXT_CHANGED/);
  assert.match(page, /\[actionRetryNonce, actionInFlight, actionWindowOpen,/,
    "the snake/nomination effect must wake when an old action becomes terminal");
  assert.match(page, /\[actionRetryNonce, actionInFlight, autoDraft, settingsConfirmed, extension, league\.draftType/,
    "the salary-cap bid effect must reconsider context that arrived before acknowledgement");
  assert.match(auditPublisher, /Single-flight, latest-only audit publisher/);
  assert.match(auditPublisher, /controller\.abort\("DRAFT_AUDIT_POST_TIMEOUT"\)/);
  assert.match(page, /ESPN roster confirmed/);
  assert.match(page, /rosterComplete: myPickCount >= league\.rosterSize/);
  assert.match(page, /enforceAvailabilityRosterFeasibility/);
  assert.match(page, /evaluateRosterCompletionFeasibility/);
  assert.equal((page.match(/className="on-clock-card panel"/g) || []).length, 1, "connection status must render once");
});

test("command-center styles preserve readable and responsive controls", () => {
  assert.match(css, /html\s*\{[^}]*font-size:\s*16px/);
  assert.match(css, /--sans:\s*"Inter Variable"/);
  assert.match(css, /--mono:\s*"Source Code Pro Variable"/);
  assert.match(css, /"Noto Sans Symbols 2"/);
  assert.match(css, /html\s*\{[^}]*font-synthesis:\s*none/);
  assert.match(layout, /import "@fontsource-variable\/inter"/);
  assert.match(layout, /import "@fontsource-variable\/source-code-pro"/);
  assert.match(layout, /import "@fontsource\/noto-sans-symbols-2"/);
  assert.equal(packageManifest.dependencies["@fontsource-variable/inter"], "5.3.0");
  assert.equal(packageManifest.dependencies["@fontsource-variable/source-code-pro"], "5.3.0");
  assert.equal(packageManifest.dependencies["@fontsource/noto-sans-symbols-2"], "5.3.0");
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

test("visual certification serves its own built artifact without weakening production start", () => {
  assert.match(visualCertification, /spawn\(process\.execPath/);
  assert.match(visualCertification, /node_modules\/vinext\/dist\/cli\.js/);
  assert.match(visualCertification, /"--hostname",\s*"127\.0\.0\.1"/);
  assert.match(visualCertification, /client\.call\("Browser\.close"\)/);
  assert.match(visualCertification, /client\.call\("Runtime\.evaluate"/);
  assert.match(visualCertification, /atob\(encoded\)/);
  assert.match(visualCertification, /createImageBitmap/);
  assert.match(visualCertification, /new OffscreenCanvas\(bitmap\.width, bitmap\.height\)/);
  assert.match(visualCertification, /left\.sum \* right\.count > right\.sum \* left\.count/);
  assert.match(visualCertification, /\^\[0-9a-f\]\{16\}\$/);
  assert.match(visualCertification, /chrome-offscreen-tile-average-dhash-9x8-bt601-v1/);
  assert.match(visualCertification, /visual baseline schema or hash algorithm mismatch/);
  assert.match(visualCertification, /visual baseline scenario set mismatch/);
  assert.match(visualCertification, /visual baseline scenario is malformed/);
  assert.match(visualCertification, /document\.fonts\.load\("400 16px 'Inter Variable'"/);
  assert.match(visualCertification, /document\.fonts\.check\("700 16px 'Source Code Pro Variable'"/);
  assert.match(visualCertification, /document\.fonts\.check\("400 16px 'Noto Sans Symbols 2'"/);
  assert.match(visualCertification, /clipped critical text/);
  assert.match(visualCertification, /auditAdversarialLongContent/);
  assert.match(visualCertification, /Marquez Valdes-Scantling/);
  assert.match(visualCertification, /scrollbar-width:none/);
  assert.match(visualCertification, /visual scrollbar normalization was not applied/);
  assert.doesNotMatch(visualCertification, /0000000000000000/);
  assert.doesNotMatch(visualCertification, /ffmpeg|execFileSync/);
  assert.match(visualCertification, /detached:\s*process\.platform === "linux"/);
  assert.match(visualCertification, /process\.kill\(-child\.pid, name\)/);
  assert.match(visualCertification, /terminateProfileProcesses\(temporaryDirectory\)/);
  assert.match(visualCertification, /signal\("SIGKILL"\);\s*if \(!await waitForStop\(3000\)\)/);
  assert.match(visualCertification, /clearTimeout\(timeout\)/);
  assert.match(visualCertification, /maxRetries:\s*8/);
  assert.match(visualCertification, /retryDelay:\s*100/);
  assert.match(visualCertification, /throw new AggregateError\(errors, "visual certification and cleanup both failed"\)/);
  assert.doesNotMatch(visualCertification, /spawn\("npm", \["run", "start"/);
});

test("visual certification escalates exact-profile cleanup and verifies every process exits", async () => {
  const observations = [[4101, 4102], [4102], []];
  const signals = [];
  const profiles = [];
  await terminateProfileProcesses("/tmp/exact-visual-profile", {
    listProcessIds: async (profilePath) => {
      profiles.push(profilePath);
      return observations.shift() ?? [];
    },
    killProcess: (pid, signal) => signals.push([pid, signal]),
    termTimeoutMs: 0,
    killTimeoutMs: 0,
    platform: "linux",
  });
  assert.deepEqual(signals, [
    [4101, "SIGTERM"],
    [4102, "SIGTERM"],
    [4102, "SIGKILL"],
  ]);
  assert.deepEqual(profiles, [
    "/tmp/exact-visual-profile",
    "/tmp/exact-visual-profile",
    "/tmp/exact-visual-profile",
  ]);
  assert.equal(observations.length, 0, "the post-KILL verification must observe an empty exact profile");
});
