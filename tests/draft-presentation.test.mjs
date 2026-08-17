import assert from "node:assert/strict";
import test from "node:test";
import { buildDraftPresentation } from "../app/lib/draft-presentation.ts";

const base = {
  draftType: "SNAKE",
  focusPlayer: { name: "Ja'Marr Chase", maxBid: 61 },
  auctionNominationPlayerName: undefined,
  ownNominationIntent: null,
  nominated: false,
  leadingBid: false,
  nextBid: 1,
  auctionCanBid: false,
  actionWindowOpen: false,
  bidWindowOpen: false,
  sourceCoverageReady: true,
  settingsConfirmed: true,
  extensionConnected: true,
  autopickActive: false,
  inDraftRoom: true,
};

test("snake presentation distinguishes ready, queued, and locked states", () => {
  assert.equal(buildDraftPresentation({ ...base, actionWindowOpen: true }).commandLabel, "DRAFT Ja'Marr Chase");
  assert.equal(buildDraftPresentation(base).commandLabel, "QUEUE Ja'Marr Chase");
  assert.equal(buildDraftPresentation({ ...base, sourceCoverageReady: false }).commandLabel, "LOCKED — REFRESH FIVE SOURCES");
  assert.equal(buildDraftPresentation({ ...base, autopickActive: true }).commandLabel, "STOPPED — ESPN AUTOPICK ACTIVE");
});

test("salary-cap presentation makes every bid discipline state explicit", () => {
  const auction = { ...base, draftType: "AUCTION", nominated: true, nextBid: 38, auctionCanBid: true };
  assert.equal(buildDraftPresentation(auction).commandLabel, "BID $38");
  assert.equal(buildDraftPresentation({ ...auction, nextBid: 62, auctionCanBid: false }).commandLabel, "PASS — CEILING $61");
  assert.equal(buildDraftPresentation({ ...auction, leadingBid: true, auctionCanBid: false }).commandLabel, "HOLD — YOU ARE LEADING");
  assert.equal(buildDraftPresentation({ ...auction, ownNominationIntent: "DRAIN", auctionCanBid: false }).commandLabel, "PASS — DO NOT PRICE ENFORCE");
  assert.equal(buildDraftPresentation({ ...auction, nominated: false, auctionCanBid: false, auctionNominationPlayerName: "Bijan Robinson" }).commandLabel, "NOMINATE Bijan Robinson");
});

test("presentation reports the fail-closed reason before general waiting state", () => {
  assert.equal(buildDraftPresentation({ ...base, autopickActive: true }).safetyLabel, "ESPN Autopick detected — actions stopped");
  assert.equal(buildDraftPresentation({ ...base, sourceCoverageReady: false }).safetyLabel, "Five-source coverage incomplete — actions locked");
  assert.equal(buildDraftPresentation({ ...base, actionWindowOpen: true }).stateTone, "ready");
  assert.equal(buildDraftPresentation({ ...base, settingsConfirmed: false }).stateTone, "blocked");
  assert.equal(buildDraftPresentation({ ...base, actionWindowOpen: true, sourceCoverageReady: false }).stateLabel, "LOCKED");
  assert.equal(buildDraftPresentation({ ...base, actionWindowOpen: true, autopickActive: true }).stateTone, "blocked");
});
