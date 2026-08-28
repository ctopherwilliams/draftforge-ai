import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const backgroundUrl = new URL("../extension/background.js", import.meta.url);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function deadlineHarness(source) {
  let nextTimerId = 1;
  const timers = new Map();
  const requests = [];
  const sandbox = {
    AbortController,
    URL,
    chrome: { tabs: { reload: async () => {} } },
    clearTimeout: (timerId) => timers.delete(timerId),
    fetch: (_url, options) => {
      requests.push(options);
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal.reason || new Error("aborted")),
          { once: true },
        );
      });
    },
    findEspnContext: async () => null,
    leagueUrl: () => new URL("https://example.test/league"),
    normalizeImportPicks: () => [],
    normalizePlayers: () => [],
    normalizeSettings: () => ({ scoringLabel: "PPR", season: 2026 }),
    recoverExactDraftRoomContext: async ({ draftLeagueId, teamId, roomTabId }) => ({
      context: { leagueId: draftLeagueId, teamId, tabId: roomTabId, season: 2026, inDraftRoom: true },
      reloadedRoom: false,
    }),
    setTimeout: (callback, delay) => {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    waitForExactDraftRoomContext: async () => null,
  };
  const helpers = sourceBetween(source, "async function espnFetch", "async function pollDraft");
  vm.runInNewContext(
    `const PRE_ROOM_IMPORT_TIMEOUT_MS = 12000;
     const LIVE_ROOM_HANDOFF_TIMEOUT_MS = 1500;
     const LIVE_WORKSPACE_RECOVERY_TIMEOUT_MS = 4000;
     ${helpers}
     globalThis.deadlineApi = {
       importPreRoomLeague,
       importLiveRoomMetadata,
       readLiveWorkspaceRecovery,
     };`,
    sandbox,
  );
  return { api: sandbox.deadlineApi, requests, timers };
}

async function startAndExpire(harness, start, expectedBudget, expectedCode) {
  const request = start();
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  assert.equal(harness.requests.length, 1, "the bounded read starts exactly one ESPN request");
  assert.equal(harness.requests[0].signal instanceof AbortSignal, true);
  assert.equal(harness.timers.size, 1);
  const timer = [...harness.timers.values()][0];
  assert.equal(timer.delay, expectedBudget);
  timer.callback();
  await assert.rejects(request, new RegExp(expectedCode));
  assert.equal(harness.requests[0].signal.aborted, true);
  assert.equal(harness.timers.size, 0);
}

test("pre-room full import aborts a never-settling ESPN fetch after one generous total budget", async () => {
  const background = await readFile(backgroundUrl, "utf8");
  const harness = deadlineHarness(background);
  await startAndExpire(
    harness,
    () => harness.api.importPreRoomLeague({ leagueId: "701", season: 2026 }),
    12000,
    "ESPN_PRE_ROOM_IMPORT_TIMEOUT",
  );
});

test("watched-room metadata handoff aborts before it can consume an opening clock", async () => {
  const background = await readFile(backgroundUrl, "utf8");
  const harness = deadlineHarness(background);
  await startAndExpire(
    harness,
    () => harness.api.importLiveRoomMetadata({ leagueId: "702", season: 2026 }),
    1500,
    "ESPN_LIVE_HANDOFF_TIMEOUT",
  );
});

test("live workspace recovery aborts a never-settling authenticated import as one transaction", async () => {
  const background = await readFile(backgroundUrl, "utf8");
  const harness = deadlineHarness(background);
  await startAndExpire(
    harness,
    () => harness.api.readLiveWorkspaceRecovery({ draftLeagueId: "703", teamId: 6, roomTabId: 44 }),
    4000,
    "ESPN_LIVE_RECOVERY_TIMEOUT",
  );
});

test("message handlers use bounded reads before creating any live action authority", async () => {
  const background = await readFile(backgroundUrl, "utf8");
  assert.match(background, /const PRE_ROOM_IMPORT_TIMEOUT_MS = 12000;/);
  assert.match(background, /const LIVE_ROOM_HANDOFF_TIMEOUT_MS = 1500;/);
  assert.match(background, /const LIVE_WORKSPACE_RECOVERY_TIMEOUT_MS = 4000;/);

  const watchHelper = sourceBetween(background, "async function performWatchedLiveRoomRecovery", "async function recoverWatchedLiveRoom");
  assert.ok(
    watchHelper.indexOf("await importLiveRoomMetadata(exactContext)")
      < watchHelper.indexOf("await establishActionBinding("),
    "a watched room cannot acquire action authority before its bounded metadata read succeeds",
  );

  const recoveryHandler = sourceBetween(
    background,
    "    if (message.type === \"RECOVER_LIVE_WORKSPACE\")",
    "    if (message.type === \"ESPN_CONTEXT\")",
  );
  assert.match(recoveryHandler, /await readLiveWorkspaceRecovery\(/);
  assert.ok(
    recoveryHandler.indexOf("await readLiveWorkspaceRecovery(")
      < recoveryHandler.indexOf("await establishActionBinding("),
    "recovery cannot acquire action authority before its bounded complete import succeeds",
  );

  const connectHandler = sourceBetween(
    background,
    "    if (message.type === \"CONNECT_ESPN\")",
    "    if (message.type === \"SUBMIT_ACTION\")",
  );
  assert.match(connectHandler, /await importPreRoomLeague\(context\)/);
  assert.ok(
    connectHandler.indexOf("await importPreRoomLeague(context)")
      < connectHandler.indexOf("await establishActionBinding("),
    "connect cannot acquire action authority from a partial pre-room import",
  );

  const listenerTail = background.slice(background.indexOf("chrome.runtime.onMessage.addListener"));
  assert.match(listenerTail, /\.then\(sendResponse\)\.catch\(async \(error\) => \{[\s\S]*?sendResponse\(\{ ok: false, code,/);
});

test("action binding, context verification, and dispatch deadlines settle even when transport never does", async () => {
  const background = await readFile(backgroundUrl, "utf8");
  const helper = sourceBetween(background, "async function withOperationDeadline", "async function fetchPlayers");
  let nextTimerId = 1;
  const timers = new Map();
  const sandbox = {
    AbortController,
    clearTimeout: (timerId) => timers.delete(timerId),
    setTimeout: (callback, delay) => {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
  };
  vm.runInNewContext(`${helper}\nglobalThis.withDeadline = withOperationDeadline;`, sandbox);

  for (const code of [
    "DRAFT_ACTION_BINDING_TIMEOUT",
    "ESPN_ACTION_CONTEXT_TIMEOUT",
    "ESPN_ACTION_DISPATCH_TIMEOUT",
  ]) {
    let observedSignal;
    const pending = sandbox.withDeadline(37, code, (signal) => {
      observedSignal = signal;
      return new Promise(() => {});
    });
    await Promise.resolve();
    assert.equal(timers.size, 1);
    const [timerId, timer] = [...timers.entries()][0];
    assert.equal(timer.delay, 37);
    timer.callback();
    await assert.rejects(pending, new RegExp(code));
    assert.equal(observedSignal.aborted, true);
    assert.equal(timers.has(timerId), false);
  }
});
