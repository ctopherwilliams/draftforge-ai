import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import {
  buildSnakePlanTiming,
  snakePlanReadyToSubmit,
} from "../app/lib/live-draft-orchestration.ts";

const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const pageAst = ts.createSourceFile(
  "app/page.tsx",
  pageSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function callbackBody(variableName) {
  let callback = null;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(pageAst) === variableName) {
      const initializer = node.initializer;
      callback = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(pageAst);
  assert.ok(callback, `${variableName} callback must exist in app/page.tsx`);
  return callback.getText(pageAst);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function liveAvailability() {
  return {
    armingAllowed: true,
    blockingReasons: [],
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    freshUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}

function buildSubmitHarness({
  draftType = "AUCTION",
  remainingSeconds = 20,
  actionWindowOpen = true,
  snakeSubmitTargetSeconds = 7,
  snakePlanKeyValue = "unused",
} = {}) {
  const availabilityWaits = [];
  const auditWaits = [];
  const sent = [];
  const decisions = [];
  const actionStates = [];
  const autoDraftStates = [];
  const retryRequests = [];
  const timers = [];
  const player = {
    id: 101,
    name: "Exact Target",
    pos: "WR",
    maxBid: 21,
    fillsMandatoryStarter: true,
  };
  const availability = liveAvailability();
  const context = {
    teamId: 6,
    inDraftRoom: true,
    autopickActive: false,
    actionSurfaceReady: true,
    onClock: true,
    remainingSeconds,
    currentPick: 1,
  };
  const publisher = {
    waitUntilAuthorized() {
      const wait = deferred();
      auditWaits.push(wait);
      return wait.promise;
    },
    isAuthorized() {
      return true;
    },
  };
  const sandbox = {
    workspaceRoleRef: { current: "writer" },
    settingsConfirmed: true,
    extension: "connected",
    sources: { complete: true },
    isCompleteFreshIntelligenceSnapshot: () => true,
    intelligenceSnapshot: {
      profileKey: "PPR|12|2026|1QB",
      sources: [],
      sourceSnapshotId: `sha256:${"c".repeat(64)}`,
      sourceSnapshotGeneratedAt: new Date().toISOString(),
    },
    activeIntelligenceSnapshotKey: "PPR|12|2026|1QB",
    acceptedIntelligenceSnapshotFresh: () => true,
    availabilityGateRef: { current: availability },
    myPickCount: 0,
    league: { id: "1603083723", teamId: 6, season: 2026, rosterSize: 16, draftType },
    actionAuthorizationEpochRef: { current: 0 },
    autoDraftRef: { current: true },
    pickFeedHealthRef: { current: { observedAt: new Date().toISOString(), lagging: false, fresh: true } },
    liveControlBlockedRef: { current: false },
    liveControlBindingRef: { current: "binding" },
    inFlightActionRef: { current: null },
    activeEspnTabRef: { current: 77 },
    activeLeagueRef: { current: "1603083723" },
    activeEspnTeamRef: { current: 6 },
    draftAuditChecklistBindingKey: () => "binding",
    draftAuditPublisherBinding: () => ({ key: "publisher-binding" }),
    liveControlRef: { current: {} },
    espnContextObservedAtRef: { current: new Date().toISOString() },
    sourceSnapshotObservedAtRef: { current: new Date().toISOString() },
    sourceSnapshotIdRef: { current: `sha256:${"c".repeat(64)}` },
    isCanonicalDraftAuditUtcTimestamp: () => true,
    isDraftAuditSourceSnapshotId: () => true,
    draftAuditPublisherRef: { current: publisher },
    lastAutoAction: { current: "" },
    bidWindowOpen: true,
    actionWindowOpen,
    remainingSeconds,
    pendingSnakeActionRef: { current: null },
    stagedSnakeDecisionRef: { current: null },
    cancelStagedSnakeDecision: () => true,
    latestEspnContextRef: { current: context },
    currentPick: 1,
    snakePlanKey: () => snakePlanKeyValue,
    deterministicSnakeSubmitSecondsRemaining: () => snakeSubmitTargetSeconds,
    snakePlanReadyToSubmit,
    actionRequestSequenceRef: { current: 0 },
    livePlayerIdentity: (candidate) => ({ id: candidate.id, name: candidate.name, position: candidate.pos }),
    liveRecommendations: [player, { id: 102, name: "Alternative", pos: "RB", maxBid: 15 }],
    createAvailabilityDecisionSnapshot({ decisionKey }) {
      decisions.push(decisionKey);
      return {
        canAct: true,
        availabilityDigest: availability.digest,
        decisionDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      };
    },
    decisionSourceFreezeRef: { current: false },
    availabilityDecisionFreezeRef: { current: false },
    setActionInFlight: () => {},
    setActionState: (message) => actionStates.push(message),
    fetchAvailabilityGate() {
      const wait = deferred();
      availabilityWaits.push(wait);
      return wait.promise;
    },
    espnPlayers: [],
    availabilityActionablePlayerIds: [],
    deferredAvailabilityGateRef: { current: null },
    revalidateAvailabilityDecision: () => ({ valid: true, reason: "CURRENT" }),
    contextMatchesActiveDraftTab: () => true,
    context,
    MIN_SNAKE_SELECTION_WINDOW_SECONDS: 10,
    MIN_OTHER_ACTION_WINDOW_SECONDS: 2,
    availabilityBoundedActionDeadline: () => Date.now() + 5_500,
    transitionLiveControl: () => true,
    liveControlActionsRef: { current: new Map() },
    clearPublishedLiveDecision: () => {},
    MAX_DRAFT_ACTION_TELEMETRY_EVENTS: 128,
    availabilityDecisionsRef: { current: new Map() },
    pendingAuctionNominationRef: { current: null },
    setPendingAuctionNomination: () => {},
    latestActionRequestRef: { current: 0 },
    pendingActionTelemetryRef: { current: new Map() },
    pendingAuctionBidRef: { current: null },
    resolveOwnRoster: () => [],
    sendToExtension(type, payload) {
      sent.push({ type, payload });
    },
    COMMAND_CENTER_PUBLISHER: { sessionId: "command-center-session" },
    DASHBOARD_LOADED_AT: "2026-08-28T12:00:00.000Z",
    actionWatchdogsRef: { current: new Map() },
    normalizeName: (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""),
    setActionRetryNonce: (update) => retryRequests.push(update),
    setAutoDraftState: (value) => autoDraftStates.push(value),
    setPickFeedHealthState: () => {},
    window: {
      setTimeout(callback, delay) {
        timers.push({ callback, delay });
        return timers.length;
      },
    },
  };
  vm.createContext(sandbox);
  for (const name of ["setAutoDraft", "setPickFeedHealth", "submit"]) {
    const source = `globalThis.__${name} = ${callbackBody(name)};`;
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    }).outputText;
    vm.runInContext(compiled, sandbox, { filename: `app/page.tsx#${name}` });
    sandbox[name] = sandbox[`__${name}`];
  }

  async function resolveAvailability(index = availabilityWaits.length - 1) {
    availabilityWaits[index].resolve(liveAvailability());
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function resolveAudit(index = auditWaits.length - 1) {
    auditWaits[index].resolve(true);
    await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    ...sandbox,
    player,
    availabilityWaits,
    auditWaits,
    sent,
    submissions: () => sent.filter((message) => message.type === "SUBMIT_ACTION"),
    decisions,
    actionStates,
    autoDraftStates,
    retryRequests,
    resolveAvailability,
    resolveAudit,
  };
}

function setBidContext(harness, overrides = {}) {
  Object.assign(harness.context, {
    onClock: false,
    auctionOfferReady: true,
    auctionTransactionMode: "OFFER",
    auctionTransactionReady: true,
    auctionSettlementPending: false,
    nominatedPlayer: harness.player.name,
    nominatedPlayerId: harness.player.id,
    currentBid: 10,
    maxLegalBid: 21,
    leadingBid: false,
    remainingSeconds: 20,
    ...overrides,
  });
}

function stageSnakeDecision(harness, timing, key = "snake-plan-key") {
  const intendedPlayer = {
    playerId: harness.player.id,
    playerName: harness.player.name,
    position: harness.player.pos,
  };
  harness.stagedSnakeDecisionRef.current = {
    key,
    actionRequestId: 1,
    action: {
      actionId: "action-snake-1",
      decisionId: "decision-snake-1",
      operation: "SELECT",
      intendedPlayer,
      phase: "PLANNED",
    },
    decision: {
      decisionId: "decision-snake-1",
      decidedAt: timing.decidedAt,
      contextCapturedAt: timing.decidedAt,
      leagueId: "1603083723",
      teamId: 6,
      tabId: 77,
      operation: "SELECT",
      sourceSnapshotId: `sha256:${"c".repeat(64)}`,
      availabilityDigest: `sha256:${"a".repeat(64)}`,
      availabilityDecisionDigest: `sha256:${"b".repeat(64)}`,
      expectedPick: 1,
      submitNotBeforeAt: timing.submitNotBeforeAt,
      submitTargetSeconds: timing.submitTargetSeconds,
      notAfter: Date.now() + 5_500,
      intendedPlayer,
      alternatives: [],
    },
    availabilityDecision: {
      canAct: true,
      availabilityDigest: `sha256:${"a".repeat(64)}`,
      decisionDigest: `sha256:${"b".repeat(64)}`,
    },
  };
}

test("a 15-to-10 snake plan dispatches only after the full five-second announcement lead and all submit gates", async () => {
  const harness = buildSubmitHarness({
    draftType: "SNAKE",
    remainingSeconds: 10,
    actionWindowOpen: true,
    snakeSubmitTargetSeconds: 10,
    snakePlanKeyValue: "snake-plan-key",
  });
  const observedAtFifteen = Date.now();
  stageSnakeDecision(harness, buildSnakePlanTiming(observedAtFifteen, 15, 10));

  await harness.submit(harness.player, true, "SELECT");
  assert.equal(harness.availabilityWaits.length, 0, "the click path must stay closed before the announcement lead elapses");
  assert.equal(harness.submissions().length, 0);
  assert.match(harness.actionStates.at(-1), /Waiting for the announced click window/);

  stageSnakeDecision(harness, buildSnakePlanTiming(Date.now() - 5_000, 15, 10));
  const authorized = harness.submit(harness.player, true, "SELECT");
  assert.equal(harness.availabilityWaits.length, 1, "the ready plan must still pass fresh availability before dispatch");
  await harness.resolveAvailability(0);
  assert.equal(harness.auditWaits.length, 1, "the ready plan must still wait for its exact audit acknowledgment");
  await harness.resolveAudit(0);
  await authorized;

  assert.equal(harness.submissions().length, 1);
  assert.equal(harness.submissions()[0].payload.operation, "SELECT");
  assert.equal(harness.submissions()[0].payload.playerId, harness.player.id);
});

test("a 14-to-9 snake observation fails closed before availability, audit, or extension dispatch", async () => {
  const harness = buildSubmitHarness({
    draftType: "SNAKE",
    remainingSeconds: 9,
    actionWindowOpen: false,
    snakeSubmitTargetSeconds: 9,
    snakePlanKeyValue: "snake-plan-key",
  });
  stageSnakeDecision(harness, buildSnakePlanTiming(Date.now() - 5_000, 14, 9));

  await harness.submit(harness.player, true, "SELECT");

  assert.equal(harness.availabilityWaits.length, 0);
  assert.equal(harness.auditWaits.length, 0);
  assert.equal(harness.submissions().length, 0);
  assert.match(harness.actionStates.at(-1), /need at least 10 seconds; ESPN shows 9s/);
});

test("turning Auto-Draft OFF during availability revalidation cancels the old action and re-enable creates a new decision", async () => {
  const harness = buildSubmitHarness();

  const cancelled = harness.submit(harness.player, true, "NOMINATE", 1, "TARGET");
  assert.equal(harness.availabilityWaits.length, 1, "the action must be waiting on fresh availability");
  harness.setAutoDraft(false);
  await harness.resolveAvailability(0);
  await cancelled;

  assert.equal(harness.submissions().length, 0, "disarming while awaited work is pending must never reach SUBMIT_ACTION");
  assert.equal(harness.auditWaits.length, 0, "a disarmed decision must be cancelled before audit publication wait");
  assert.match(harness.actionStates.at(-1), /Action cancelled before audit: authorization changed/);

  harness.setAutoDraft(true);
  const replacement = harness.submit(harness.player, true, "NOMINATE", 1, "TARGET");
  assert.deepEqual(harness.decisions, ["decision-1", "decision-2"], "re-enable must not reuse the cancelled decision identity");
  await harness.resolveAvailability(1);
  assert.equal(harness.auditWaits.length, 1, JSON.stringify(harness.actionStates));
  await harness.resolveAudit(0);
  await replacement;

  assert.equal(harness.submissions().length, 1);
  assert.equal(harness.submissions()[0].payload.actionRequestId, 2);
});

test("authenticated pick-feed staleness during availability wait cancels with zero SUBMIT_ACTION", async () => {
  const harness = buildSubmitHarness();

  const cancelled = harness.submit(harness.player, true, "NOMINATE", 1, "TARGET");
  harness.setPickFeedHealth({ observedAt: new Date().toISOString(), lagging: true, fresh: false });
  await harness.resolveAvailability(0);
  await cancelled;

  assert.equal(harness.submissions().length, 0);
  assert.equal(harness.auditWaits.length, 0);
  assert.match(harness.actionStates.at(-1), /Action cancelled before audit: authorization changed/);
});

test("authenticated pick-feed staleness during audit wait cancels, then a fresh feed creates a new authorized decision", async () => {
  const harness = buildSubmitHarness();

  const cancelled = harness.submit(harness.player, true, "NOMINATE", 1, "TARGET");
  await harness.resolveAvailability(0);
  assert.equal(harness.auditWaits.length, 1, `the first decision must be blocked on its exact audit acknowledgement: ${JSON.stringify(harness.actionStates)}`);
  harness.setPickFeedHealth({ observedAt: new Date().toISOString(), lagging: true, fresh: false });
  await harness.resolveAudit(0);
  await cancelled;

  assert.equal(harness.submissions().length, 0, "a stale authenticated feed must revoke authorization after audit too");
  assert.match(harness.actionStates.at(-1), /Action cancelled after audit: authorization changed/);

  harness.setPickFeedHealth({ observedAt: new Date().toISOString(), lagging: false, fresh: true });
  const replacement = harness.submit(harness.player, true, "NOMINATE", 1, "TARGET");
  assert.deepEqual(harness.decisions, ["decision-1", "decision-2"], "feed recovery must re-plan under a new identity");
  await harness.resolveAvailability(1);
  await harness.resolveAudit(1);
  await replacement;

  assert.equal(harness.submissions().length, 1);
  assert.equal(harness.submissions()[0].payload.actionRequestId, 2);
});

test("a bid above ESPN's exact reserve ceiling walks immediately without audit, dispatch, or disarm", async () => {
  const harness = buildSubmitHarness();
  setBidContext(harness, { maxLegalBid: 10 });

  await harness.submit(harness.player, true, "BID", 11);

  assert.equal(harness.availabilityWaits.length, 0);
  assert.equal(harness.auditWaits.length, 0);
  assert.equal(harness.submissions().length, 0);
  assert.deepEqual(harness.autoDraftStates, []);
  assert.match(harness.actionStates.at(-1), /Walk away.*exact \$10 ceiling/);
});

test("a legal bid dispatches the minimum of source and live ESPN ceilings", async () => {
  const harness = buildSubmitHarness();
  setBidContext(harness, { maxLegalBid: 17 });

  const pending = harness.submit(harness.player, true, "BID", 11);
  await harness.resolveAvailability(0);
  await harness.resolveAudit(0);
  await pending;

  assert.equal(harness.submissions().length, 1);
  assert.equal(harness.submissions()[0].payload.amount, 11);
  assert.equal(harness.submissions()[0].payload.maxApprovedBid, 17);
  assert.equal(harness.liveControlActionsRef.current.get(1)?.intendedOffer, 11);
  assert.equal(harness.liveControlActionsRef.current.get(1)?.phase, "PLANNED");
});

test("a reserve ceiling that falls below the next bid during availability becomes a normal walk-away", async () => {
  const harness = buildSubmitHarness();
  setBidContext(harness);

  const pending = harness.submit(harness.player, true, "BID", 11);
  harness.context.maxLegalBid = 10;
  await harness.resolveAvailability(0);
  await pending;

  assert.equal(harness.auditWaits.length, 0);
  assert.equal(harness.submissions().length, 0);
  assert.deepEqual(harness.autoDraftStates, []);
  assert.match(harness.actionStates.at(-1), /reserve ceiling fell to \$10 before the bid was audited/);
});

test("a changed but still legal reserve ceiling is re-planned instead of dispatched under a stale audit identity", async () => {
  const harness = buildSubmitHarness();
  setBidContext(harness);

  const pending = harness.submit(harness.player, true, "BID", 11);
  await harness.resolveAvailability(0);
  harness.context.maxLegalBid = 15;
  await harness.resolveAudit(0);
  await pending;

  assert.equal(harness.submissions().length, 0);
  assert.equal(harness.retryRequests.length, 1);
  assert.deepEqual(harness.autoDraftStates, []);
  assert.match(harness.actionStates.at(-1), /re-evaluating the latest transaction/i);
});

test("a reserve ceiling that falls below the next bid during audit cancels without dispatch or disarm", async () => {
  const harness = buildSubmitHarness();
  setBidContext(harness);

  const pending = harness.submit(harness.player, true, "BID", 11);
  await harness.resolveAvailability(0);
  harness.context.maxLegalBid = 10;
  await harness.resolveAudit(0);
  await pending;

  assert.equal(harness.submissions().length, 0);
  assert.deepEqual(harness.autoDraftStates, []);
  assert.match(harness.actionStates.at(-1), /reserve ceiling fell to \$10 before dispatch/);
});

test("same-name nominee churn to another exact ESPN id cancels before audit", async () => {
  const harness = buildSubmitHarness();
  setBidContext(harness);

  const pending = harness.submit(harness.player, true, "BID", 11);
  harness.context.nominatedPlayerId = 202;
  await harness.resolveAvailability(0);
  await pending;

  assert.equal(harness.auditWaits.length, 0);
  assert.equal(harness.submissions().length, 0);
  assert.equal(harness.retryRequests.length, 1);
  assert.deepEqual(harness.autoDraftStates, []);
});

test("same-name nominee churn to another exact ESPN id cancels after audit", async () => {
  const harness = buildSubmitHarness();
  setBidContext(harness);

  const pending = harness.submit(harness.player, true, "BID", 11);
  await harness.resolveAvailability(0);
  harness.context.nominatedPlayerId = 202;
  await harness.resolveAudit(0);
  await pending;

  assert.equal(harness.submissions().length, 0);
  assert.equal(harness.retryRequests.length, 1);
  assert.deepEqual(harness.autoDraftStates, []);
});

test("a present but invalid ESPN nominee id never falls back to the same display name", async () => {
  const harness = buildSubmitHarness();
  setBidContext(harness, { nominatedPlayerId: 0 });

  const pending = harness.submit(harness.player, true, "BID", 11);
  await harness.resolveAvailability(0);
  await pending;

  assert.equal(harness.auditWaits.length, 0);
  assert.equal(harness.submissions().length, 0);
  assert.equal(harness.retryRequests.length, 1);
  assert.deepEqual(harness.autoDraftStates, []);
});

test("nominee name fallback remains available only when ESPN omits the nominee id", async () => {
  const harness = buildSubmitHarness();
  setBidContext(harness, { nominatedPlayerId: null });

  const pending = harness.submit(harness.player, true, "BID", 11);
  await harness.resolveAvailability(0);
  await harness.resolveAudit(0);
  await pending;

  assert.equal(harness.submissions().length, 1);
  assert.equal(harness.submissions()[0].payload.playerId, harness.player.id);
  assert.equal(harness.submissions()[0].payload.maxApprovedBid, 21);
});

test("binding revocation ACK timeout preserves the old exact identity and blocks every workspace transition", async () => {
  const actionStates = [];
  const extensionStates = [];
  const requested = [];
  const sandbox = {
    bindingTransitionOwnerRef: { current: null },
    actionAuthorizationEpochRef: { current: 40 },
    activeEspnTabRef: { current: 77 },
    activeLeagueRef: { current: "701" },
    activeEspnTeamRef: { current: 5 },
    COMMAND_CENTER_PUBLISHER: { sessionId: "transition-command-center" },
    setAutoDraft: () => { sandbox.actionAuthorizationEpochRef.current += 1; },
    setActionState: (message) => actionStates.push(message),
    setExtension: (state) => extensionStates.push(state),
    async requestExtensionCommand(type, payload) {
      requested.push({ type, payload: structuredClone(payload) });
      return { ok: false, code: "ACTION_BINDING_REVOCATION_ACK_TIMEOUT" };
    },
  };
  vm.createContext(sandbox);
  const source = `globalThis.__revoke = ${callbackBody("revokeActiveBindingForTransition")};`;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  vm.runInContext(compiled, sandbox, { filename: "app/page.tsx#revokeActiveBindingForTransition" });

  const accepted = await sandbox.__revoke("Opening draft preview");
  assert.equal(accepted, null);
  assert.equal(sandbox.bindingTransitionOwnerRef.current, null, "the acquiring owner releases its failed transition lock");
  assert.equal(sandbox.actionAuthorizationEpochRef.current, 41, "the local epoch is revoked synchronously");
  assert.deepEqual(requested[0], {
    type: "REVOKE_ACTION_BINDING",
    payload: {
      commandCenterSessionId: "transition-command-center",
      expectedLeagueId: "701",
      expectedTeamId: 5,
      expectedTabId: 77,
      minimumAuthorizationEpoch: 41,
    },
  });
  assert.equal(sandbox.activeEspnTabRef.current, 77);
  assert.equal(sandbox.activeLeagueRef.current, "701");
  assert.equal(sandbox.activeEspnTeamRef.current, 5);
  assert.deepEqual(extensionStates, ["error"]);
  assert.match(actionStates.at(-1), /Transition blocked: ACTION_BINDING_REVOCATION_ACK_TIMEOUT/);

  for (const transitionName of ["activateProfile", "startAnotherLeague", "previewDraftFormat"]) {
    const start = pageSource.indexOf(`async function ${transitionName}`);
    assert.ok(start >= 0, `${transitionName} must remain an explicit async transition`);
    const revokeAt = pageSource.indexOf("await revokeActiveBindingForTransition", start);
    const clearAt = pageSource.indexOf("clearLiveControl();", start);
    const nextFunction = pageSource.indexOf("\n  async function ", start + 1);
    assert.ok(revokeAt > start && clearAt > revokeAt, `${transitionName} revokes before clearing local binding state`);
    assert.ok(nextFunction < 0 || clearAt < nextFunction, `${transitionName} owns its guarded clear`);
  }
});

test("rapid competing workspace transitions keep one owner until its exact revocation ACK completes", async () => {
  let releaseAck;
  const ack = new Promise((resolve) => { releaseAck = resolve; });
  const requests = [];
  const sandbox = {
    bindingTransitionOwnerRef: { current: null },
    actionAuthorizationEpochRef: { current: 7 },
    activeEspnTabRef: { current: 77 },
    activeLeagueRef: { current: "701" },
    activeEspnTeamRef: { current: 5 },
    COMMAND_CENTER_PUBLISHER: { sessionId: "transition-owner-session" },
    setAutoDraft: () => { sandbox.actionAuthorizationEpochRef.current += 1; },
    setActionState: () => {},
    setExtension: () => {},
    requestExtensionCommand(type, payload) {
      requests.push({ type, payload: structuredClone(payload) });
      return ack;
    },
  };
  vm.createContext(sandbox);
  for (const callback of ["revokeActiveBindingForTransition", "finishBindingTransition"]) {
    const source = `globalThis.__${callback} = ${callbackBody(callback)};`;
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    vm.runInContext(compiled, sandbox, { filename: `app/page.tsx#${callback}` });
  }

  const first = sandbox.__revokeActiveBindingForTransition("Switching saved league");
  const second = await sandbox.__revokeActiveBindingForTransition("Importing another league");
  const third = await sandbox.__revokeActiveBindingForTransition("Opening draft preview");
  assert.equal(second, null);
  assert.equal(third, null);
  assert.equal(requests.length, 1, "only the transition owner can request revocation");
  assert.equal(sandbox.actionAuthorizationEpochRef.current, 8, "losing transitions cannot raise or clear the owner's epoch");
  const activeOwner = sandbox.bindingTransitionOwnerRef.current;
  assert.equal(typeof activeOwner, "string");
  assert.ok(activeOwner.length > 0);

  releaseAck({
    ok: true,
    code: "ACTION_BINDING_REVOKED",
    revokedTabId: 77,
    revokedLeagueId: "701",
    revokedTeamId: 5,
    minimumAuthorizationEpoch: Number.MAX_SAFE_INTEGER,
  });
  const acquired = await first;
  assert.equal(acquired, activeOwner);
  assert.equal(sandbox.bindingTransitionOwnerRef.current, activeOwner, "ACK does not release before the owner applies its transition");
  sandbox.__finishBindingTransition("not-the-owner");
  assert.equal(sandbox.bindingTransitionOwnerRef.current, activeOwner, "a losing transition cannot unlock the owner");
  sandbox.__finishBindingTransition(acquired);
  assert.equal(sandbox.bindingTransitionOwnerRef.current, null);
});
