import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createPollCoordinator } from "../extension/poll-coordinator.js";

const backgroundUrl = new URL("../extension/background.js", import.meta.url);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("live ESPN draft polling has a hard transport deadline without shortening full imports", async () => {
  const background = await readFile(backgroundUrl, "utf8");
  assert.match(background, /const LIVE_DRAFT_POLL_FETCH_TIMEOUT_MS = 1100;/);
  assert.match(background, /const LIVE_DRAFT_POLL_COORDINATOR_TIMEOUT_MS = 1200;/);
  assert.match(background, /createPollCoordinator\(\{[\s\S]*taskTimeoutMs: LIVE_DRAFT_POLL_COORDINATOR_TIMEOUT_MS/);
  assert.match(background, /async function pollDraft\([\s\S]*timeoutMs: LIVE_DRAFT_POLL_FETCH_TIMEOUT_MS/);
  assert.doesNotMatch(
    sourceBetween(background, "async function fetchPlayers", "async function pollDraft"),
    /timeoutMs/,
    "full player and league imports must not inherit the 1.1-second live-poll deadline",
  );

  const espnFetchSource = sourceBetween(background, "async function espnFetch", "async function fetchPlayers");
  const timers = new Map();
  let nextTimerId = 1;
  const requests = [];
  const sandbox = {
    AbortController,
    clearTimeout: (timerId) => timers.delete(timerId),
    fetch: (_url, options) => {
      requests.push(options);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
      });
    },
    setTimeout: (callback, delay) => {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
  };
  vm.runInNewContext(`${espnFetchSource}\nglobalThis.testEspnFetch = espnFetch;`, sandbox);

  const request = sandbox.testEspnFetch("https://example.test/live", {
    headers: { "X-Test": "yes" },
    timeoutMs: 1100,
    timeoutCode: "ESPN_POLL_TIMEOUT",
  });
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].timeoutMs, undefined, "internal timeout metadata must never reach fetch");
  assert.equal(requests[0].credentials, "include");
  assert.equal(requests[0].headers.Accept, "application/json");
  assert.equal(requests[0].headers["X-Test"], "yes");
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 1100);

  [...timers.values()][0].callback();
  await assert.rejects(request, /ESPN_POLL_TIMEOUT/);
  assert.equal(timers.size, 0);
});

test("full ESPN imports remain unbounded by the live-poll transport timeout", async () => {
  const background = await readFile(backgroundUrl, "utf8");
  const espnFetchSource = sourceBetween(background, "async function espnFetch", "async function fetchPlayers");
  let timerCalls = 0;
  let fetchOptions;
  const sandbox = {
    AbortController,
    clearTimeout: () => {},
    fetch: async (_url, options) => {
      fetchOptions = options;
      return { status: 200, ok: true, json: async () => ({ imported: true }) };
    },
    setTimeout: () => {
      timerCalls += 1;
      return 1;
    },
  };
  vm.runInNewContext(`${espnFetchSource}\nglobalThis.testEspnFetch = espnFetch;`, sandbox);

  assert.deepEqual(await sandbox.testEspnFetch("https://example.test/import"), { imported: true });
  assert.equal(timerCalls, 0);
  assert.equal(fetchOptions.signal, undefined);
  assert.equal(fetchOptions.credentials, "include");
});

test("a live network poll publishes picks plus immutable identity, never volatile DOM context", async () => {
  const background = await readFile(backgroundUrl, "utf8");
  const pollSource = sourceBetween(background, "async function pollDraft", "async function pollDraftIfDue");
  const requests = [];
  const sandbox = {
    LIVE_DRAFT_POLL_FETCH_TIMEOUT_MS: 1100,
    espnFetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return { draftDetail: { picks: [1] }, teams: [] };
    },
    leagueUrl: (leagueId, season, views) => ({ leagueId, season, views }),
    normalizePicks: () => [{ id: 1 }],
  };
  vm.runInNewContext(`${pollSource}\nglobalThis.poll = pollDraft;`, sandbox);
  const result = await sandbox.poll({ leagueId: "701", teamId: 5, season: 2026, tabId: 41 }, new AbortController().signal);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    picks: [{ id: 1 }],
    draftDetail: { picks: [1] },
    identity: { leagueId: "701", teamId: 5, season: 2026, tabId: 41 },
  });
  assert.equal("context" in result, false);
  assert.equal(requests[0].options.timeoutCode, "ESPN_POLL_TIMEOUT");
});

test("heartbeat bursts schedule immediately, coalesce to one room poll, and recover after timeout", async () => {
  const background = await readFile(backgroundUrl, "utf8");
  const pollingSource = sourceBetween(background, "async function pollDraftIfDue", "async function recoverWatchedLiveRoom");
  const listenerSource = sourceBetween(
    background,
    "    if (message.type === \"ESPN_CONTEXT\")",
    "    if (message.type === \"ESPN_ACTION_RESOLVED\")",
  );
  assert.doesNotMatch(listenerSource, /await pollDraftIfDue/);
  assert.match(listenerSource, /scheduleDraftPoll\(espnContext\)/);
  assert.match(listenerSource, /scheduleDraftPoll\(context\)/);

  let clock = 10_000;
  let nextTimerId = 1;
  const timers = new Map();
  const setTimer = (callback, delay) => {
    const timerId = nextTimerId++;
    timers.set(timerId, { callback, dueAt: clock + delay });
    return timerId;
  };
  const clearTimer = (timerId) => timers.delete(timerId);
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  const advance = async (milliseconds) => {
    clock += milliseconds;
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.dueAt <= clock)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [timerId, timer] of due) {
      timers.delete(timerId);
      timer.callback();
    }
    await flush();
  };
  const draftPolls = createPollCoordinator({
    minIntervalMs: 1800,
    taskTimeoutMs: 1200,
    now: () => clock,
    setTimer,
    clearTimer,
  });
  let pollCalls = 0;
  let completeNextPoll = false;
  let settleHungPoll;
  const broadcasts = [];
  const sandbox = {
    broadcast: async (type, data) => broadcasts.push({ type, data }),
    draftPolls,
    pollDraft: async () => {
      pollCalls += 1;
      if (!completeNextPoll) {
        return new Promise((resolve) => {
          settleHungPoll = () => resolve({ picks: [{ id: 0 }], identity: { leagueId: "701", teamId: 5, season: 2026, tabId: 41 } });
        });
      }
      return { picks: [{ id: 1 }], identity: { leagueId: "701", teamId: 5, season: 2026, tabId: 41 } };
    },
  };
  vm.runInNewContext(
    `${pollingSource}\nglobalThis.testScheduleDraftPoll = scheduleDraftPoll;`,
    sandbox,
  );

  const room = { tabId: 41, leagueId: "701", inDraftRoom: true };
  const scheduled = Array.from({ length: 1000 }, () => sandbox.testScheduleDraftPoll(room));
  assert.equal(scheduled.every((result) => result.scheduled === true), true);
  await flush();
  assert.equal(pollCalls, 1, "one exact room may have only one in-flight ESPN API poll");
  assert.equal(broadcasts.length, 0);

  await advance(1200);
  clock += 1800;
  assert.equal(sandbox.testScheduleDraftPoll(room).scheduled, true);
  await flush();
  assert.equal(pollCalls, 1, "a timed-out room stays quarantined while its underlying transport is unsettled");
  assert.equal(broadcasts.length, 0);

  settleHungPoll();
  await flush();
  assert.equal(broadcasts.length, 0, "a late result from an aborted poll must never be broadcast");

  completeNextPoll = true;
  assert.equal(sandbox.testScheduleDraftPoll(room).scheduled, true);
  await flush();
  assert.equal(pollCalls, 2, "the room slot admits a later healthy poll only after quarantine settles");
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, "DF_DRAFT_UPDATE");
  assert.deepEqual(
    JSON.parse(JSON.stringify(broadcasts[0].data)),
    {
      picks: [{ id: 1 }],
      identity: { leagueId: "701", teamId: 5, season: 2026, tabId: 41 },
    },
    "a delayed network poll may publish immutable room identity but never stale clock/nominee context",
  );
});
