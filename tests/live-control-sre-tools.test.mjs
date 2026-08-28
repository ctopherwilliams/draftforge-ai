import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runLiveControlChaosSuite } from "../scripts/live-control-chaos.mjs";
import { liveControlFixturePayload, startLiveControlFixture } from "../scripts/live-control-fixture.mjs";
import { parseLiveControlLoadArguments, runLiveControlLoad } from "../scripts/live-control-load.mjs";
import { parseLiveControlSoakArguments, runLiveControlSoak } from "../scripts/live-control-soak.mjs";
import {
  acquireLiveControlMonitorLock,
  createLiveControlSampleReporter,
  fetchLiveControlSnapshot,
  liveControlMonitorLockPath,
  normalizeLoopbackOrigin,
  parseLiveControlMonitorArguments,
  runLiveControlMonitor,
} from "../scripts/live-control-monitor.mjs";

function maxRetainedLifecycleEvents() {
  return Array.from({ length: 256 }, (_, index) => ({
    sequence: 45 + index,
    occurredAt: new Date(Date.parse("2026-08-28T01:00:00.000Z") + index).toISOString(),
    kind: "ACTION_LIFECYCLE",
    actionId: `bootstrap-action-${index}`,
    decisionId: `bootstrap-decision-${index}`,
    operation: "SELECT",
    phase: "ACTION_COMPLETED",
    intendedPlayer: {
      playerId: index + 1,
      playerName: `Retained bootstrap player ${String(index).padStart(3, "0")} ${"x".repeat(80)}`,
      position: "WR",
    },
  }));
}

function rolledPublisherResponder(retainedEvents = maxRetainedLifecycleEvents()) {
  return ({ request }) => {
    const since = Number(new URL(request.url, "http://127.0.0.1").searchParams.get("since") || 0);
    return {
      status: 200,
      body: liveControlFixturePayload({
        sequence: 300,
        since,
        events: since === 0 ? retainedEvents : undefined,
      }),
    };
  };
}

function operatorSnapshot(playerName = "Recommended Receiver") {
  return {
    room: {
      round: 4,
      pick: 37,
      onClock: true,
      secondsRemaining: 23,
      nominee: null,
      currentBid: null,
      leader: null,
      maxLegalBid: null,
    },
    team: {
      remainingBudget: null,
      openRosterSlots: 12,
      primaryNeeds: [{ position: "RB", count: 2 }],
    },
    recommendation: {
      state: "ACTIVE",
      action: "SELECT",
      player: { playerId: 101, playerName, position: "WR", team: "CIN" },
      offer: null,
      maxLegalBid: null,
    },
    alternatives: [{
      player: { playerId: 102, playerName: "Alternative Runner", position: "RB", team: "ATL" },
      maxLegalBid: null,
    }],
    lastDecision: null,
  };
}

test("monitor accepts only exact bounded loopback reads", () => {
  assert.equal(normalizeLoopbackOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => normalizeLoopbackOrigin("https://127.0.0.1:3000"), /MUST_BE_LOOPBACK/);
  assert.throws(() => normalizeLoopbackOrigin("http://192.168.1.10:3000"), /MUST_BE_LOOPBACK/);
  assert.throws(() => normalizeLoopbackOrigin("http://127.0.0.1:3000/path"), /MUST_BE_LOOPBACK/);
  assert.throws(() => parseLiveControlMonitorArguments(["--league", "1603083723"]), /--team/);
  const options = parseLiveControlMonitorArguments([
    "--origin", "http://127.0.0.1:3000",
    "--league", "1603083723",
    "--team", "6",
    "--polls", "3",
  ]);
  assert.equal(options.polls, 3);
  assert.equal(options.intervalMs, 1_000);
  assert.equal(options.maxBytes, 131_072);
  assert.throws(() => parseLiveControlMonitorArguments([
    "--league", "1603083723", "--team", "6", "--interval-ms", "499",
  ]), /must be an integer from 500/);
  assert.equal(parseLiveControlMonitorArguments([
    "--league", "1603083723", "--team", "6", "--interval-ms", "10", "--test-mode",
  ]).intervalMs, 10);
  assert.throws(() => parseLiveControlMonitorArguments([
    "--league", "1603083723", "--team", "6", "--max-bytes", "262145",
  ]), /must be an integer/);
});

test("production monitor lock rejects a duplicate across loopback aliases and cleans up", async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), "draftforge-monitor-lock-"));
  const options = parseLiveControlMonitorArguments([
    "--origin", "http://127.0.0.1:3000",
    "--league", "1603083723",
    "--team", "6",
  ]);
  const aliasOptions = { ...options, origin: "http://localhost:3000" };
  try {
    assert.equal(
      liveControlMonitorLockPath(options, { baseDirectory }).path,
      liveControlMonitorLockPath(aliasOptions, { baseDirectory }).path,
    );
    const owner = await acquireLiveControlMonitorLock(options, { baseDirectory });
    await access(owner.path);
    await assert.rejects(
      acquireLiveControlMonitorLock(aliasOptions, { baseDirectory }),
      (error) => error?.code === "LIVE_CONTROL_MONITOR_ALREADY_RUNNING" && /pid/.test(error.message),
    );
    assert.equal(await owner.release(), true);
    await assert.rejects(access(owner.path), (error) => error?.code === "ENOENT");
    assert.equal(await owner.release(), false);
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test("production monitor lock recovers a dead owner without letting it clean a replacement", async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), "draftforge-monitor-stale-"));
  const options = parseLiveControlMonitorArguments([
    "--league", "44050",
    "--team", "7",
  ]);
  try {
    const staleOwner = await acquireLiveControlMonitorLock(options, {
      baseDirectory,
      processId: 999_999,
    });
    const replacement = await acquireLiveControlMonitorLock(options, {
      baseDirectory,
      isProcessAlive(pid) {
        assert.equal(pid, 999_999);
        return false;
      },
    });
    assert.notEqual(replacement.token, staleOwner.token);
    assert.equal(await staleOwner.release(), false);
    await access(replacement.path);
    assert.equal(await replacement.release(), true);
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test("concurrent stale-lock reclaimers leave one owner and no reclaim artifacts", async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), "draftforge-monitor-concurrent-stale-"));
  const options = parseLiveControlMonitorArguments([
    "--league", "1603083723",
    "--team", "6",
  ]);
  try {
    const staleOwner = await acquireLiveControlMonitorLock(options, {
      baseDirectory,
      processId: 999_999,
    });
    const contenderOptions = {
      baseDirectory,
      isProcessAlive(pid) {
        return pid !== 999_999;
      },
    };
    const results = await Promise.allSettled([
      acquireLiveControlMonitorLock(options, contenderOptions),
      acquireLiveControlMonitorLock(options, contenderOptions),
    ]);
    const owners = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(owners.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(["LIVE_CONTROL_MONITOR_ALREADY_RUNNING", "LIVE_CONTROL_MONITOR_LOCK_CONTENDED"].includes(rejected[0].reason?.code));

    const stored = JSON.parse(await readFile(owners[0].path, "utf8"));
    assert.equal(stored.token, owners[0].token);
    assert.equal(await staleOwner.release(), false, "the stale token cannot remove its replacement");
    await access(owners[0].path);
    assert.deepEqual(
      (await readdir(owners[0].directory)).filter((name) => name.includes(".stale.") || name.endsWith(".reclaim")),
      [],
    );
    assert.equal(await owners[0].release(), true);
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test("production monitor signal termination removes its exact-room lock", async () => {
  const fixture = await startLiveControlFixture();
  const options = parseLiveControlMonitorArguments([
    "--origin", fixture.origin,
    "--league", "1603083723",
    "--team", "6",
  ]);
  const lock = liveControlMonitorLockPath(options);
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../scripts/live-control-monitor.mjs", import.meta.url)),
    "--origin", fixture.origin,
    "--league", "1603083723",
    "--team", "6",
    "--polls", "100",
    "--interval-ms", "500",
    "--quiet",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  try {
    const deadline = Date.now() + 3_000;
    while (true) {
      try {
        await access(lock.path);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const exit = once(child, "exit");
    assert.equal(child.kill("SIGTERM"), true);
    const [exitCode] = await exit;
    assert.equal(exitCode, 1);
    await assert.rejects(access(lock.path), (error) => error?.code === "ENOENT");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(lock.path, { force: true });
    await fixture.close();
  }
});

test("monitor output is change-only with bounded sanitized health heartbeats", () => {
  let now = 0;
  const lines = [];
  const report = createLiveControlSampleReporter({
    now: () => now,
    writeLine: (line) => lines.push(line),
  });
  const playerName = `Receiver\n\u0000${"x".repeat(500)}`;
  const changed = liveControlFixturePayload({
    sequence: 256,
    since: 0,
    events: Array.from({ length: 256 }, (_, index) => ({
      sequence: index + 1,
      occurredAt: "2026-08-28T01:00:00.000Z",
      kind: "ACTION_LIFECYCLE",
      actionId: `action-${index}`,
      decisionId: "decision-1",
      operation: "BID",
      phase: "PLANNED",
      intendedPlayer: { playerId: index + 1, playerName, position: "WR" },
      intendedOffer: 12,
    })),
    overrides: {
      decision: {
        decisionId: "decision-1",
        decidedAt: "2026-08-28T01:00:00.000Z",
        contextCapturedAt: "2026-08-28T01:00:00.000Z",
        operation: "BID",
        sourceSnapshotId: "source-snapshot",
        intendedPlayer: { playerId: 1, playerName, position: "WR" },
        intendedOffer: 12,
        maxApprovedBid: 18,
        alternatives: [],
      },
    },
  }).control;
  const first = report({ poll: 1, control: changed, operator: operatorSnapshot(), bytes: 120_000, latencyMs: 1.234 });
  assert.equal(first.kind, "change");
  assert.ok(first.eventsOmitted > 0);

  const unchanged = { ...changed, unchanged: true, events: [] };
  now = 1_000;
  assert.equal(report({ poll: 2, control: unchanged, operator: operatorSnapshot(), bytes: 900, latencyMs: 1 }), null);
  now = 30_000;
  const heartbeat = report({ poll: 3, control: unchanged, operator: operatorSnapshot(), bytes: 900, latencyMs: 1 });
  assert.equal(heartbeat.kind, "health");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 16_384));
  const changeLine = JSON.parse(lines[0]);
  const heartbeatLine = JSON.parse(lines[1]);
  assert.equal(changeLine.decision.intendedPlayer.playerName.length, 160);
  assert.equal(changeLine.operator.recommendation.player.playerName, "Recommended Receiver");
  assert.equal(changeLine.events.at(-1).sequence, 256);
  assert.equal([...changeLine.decision.intendedPlayer.playerName].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  }), false);
  assert.equal("decision" in heartbeatLine, false);
  assert.equal("events" in heartbeatLine, false);
});

test("operator-only changes emit a bounded read-only update without a control event", () => {
  const lines = [];
  const report = createLiveControlSampleReporter({ writeLine: (line) => lines.push(line) });
  const control = liveControlFixturePayload({ sequence: 7, since: 7 }).control;
  const first = report({ poll: 1, control, operator: operatorSnapshot("First Choice"), bytes: 1_000, latencyMs: 1 });
  const second = report({ poll: 2, control, operator: operatorSnapshot("Second Choice"), bytes: 1_000, latencyMs: 1 });
  const unchanged = report({ poll: 3, control, operator: operatorSnapshot("Second Choice"), bytes: 1_000, latencyMs: 1 });
  assert.equal(first.kind, "change");
  assert.equal(second.kind, "change");
  assert.equal(unchanged, null);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).operator.recommendation.player.playerName, "Second Choice");
});

test("release gate enforces the documented low-latency budgets", async () => {
  const source = await readFile(new URL("../scripts/live-control-release-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /"--p95-ms", "25"/);
  assert.match(source, /"--p99-ms", "50"/);
  for (const criticalTest of [
    "async-submit-authorization.test.mjs",
    "availability-stage-store.test.mjs",
    "background-action-authorization.test.mjs",
    "draft-audit-publisher.test.mjs",
    "draft-day-doctor.test.mjs",
    "draft-day-readiness.test.mjs",
    "draft-day-status.test.mjs",
    "draft-day-warm.test.mjs",
    "live-control-recovery-page.test.mjs",
    "live-control-recovery.test.mjs",
    "producer-sequencing.test.mjs",
    "production-supervisor.test.mjs",
    "roster-completion-feasibility.test.mjs",
  ]) {
    assert.match(source, new RegExp(`tests/${criticalTest.replaceAll(".", "\\.")}`), criticalTest);
  }
});

test("monitor gates reconciled feed observation and lag independently from event age", async () => {
  const options = parseLiveControlMonitorArguments([
    "--league", "1603083723",
    "--team", "6",
    "--max-pick-age-ms", "2500",
  ]);
  const read = async (mutate) => {
    const payload = liveControlFixturePayload();
    mutate(payload.control);
    const body = JSON.stringify(payload);
    return fetchLiveControlSnapshot(options, {
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
      }),
    });
  };

  const slowTurn = await read((control) => {
    control.agesMs.pickFeed = 60_000;
  });
  assert.equal(slowTurn.control.agesMs.pickFeedObserved, 0);

  await assert.rejects(
    read((control) => { control.agesMs.pickFeedObserved = 2_501; }),
    (error) => error?.code === "LIVE_CONTROL_STALE" && /PICK_FEED_STALE/.test(error.message),
  );
  await assert.rejects(
    read((control) => { control.freshness.pickFeedLagging = true; }),
    (error) => error?.code === "LIVE_CONTROL_STALE" && /PICK_FEED_LAGGING/.test(error.message),
  );
  await assert.rejects(
    read((control) => { control.agesMs.pickFeedObserved = -1; }),
    (error) => error?.code === "LIVE_CONTROL_STALE" && /PICK_FEED_STALE/.test(error.message),
  );

  const invalidOperatorPayload = liveControlFixturePayload();
  invalidOperatorPayload.operator = { memberId: "private-member-id" };
  const invalidOperatorBody = JSON.stringify(invalidOperatorPayload);
  await assert.rejects(
    fetchLiveControlSnapshot(options, {
      fetchImpl: async () => new Response(invalidOperatorBody, {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(invalidOperatorBody)) },
      }),
    }),
    (error) => error?.code === "LIVE_CONTROL_OPERATOR_INVALID",
  );
});

test("compact monitor is GET-only, incremental, bounded, and self-terminating", async () => {
  const fixture = await startLiveControlFixture();
  try {
    const result = await runLiveControlMonitor({
      ...parseLiveControlMonitorArguments([
        "--origin", fixture.origin,
        "--league", "1603083723",
        "--team", "6",
        "--polls", "3",
        "--interval-ms", "10",
        "--test-mode",
      ]),
    });
    assert.equal(result.ok, true);
    assert.equal(result.polls, 3);
    assert.equal(result.finalSequence, 7);
    assert.equal(fixture.stats.requests, 3);
    assert.deepEqual([...new Set(fixture.stats.methods)], ["GET"]);
    assert.ok(fixture.stats.urls.every((url) => url.includes("view=control")));
  } finally {
    await fixture.close();
  }
});

test("compact monitor fails closed when retained events are not exactly consecutive", async () => {
  const fixture = await startLiveControlFixture({
    responder: ({ requestNumber }) => ({
      status: 200,
      body: requestNumber === 1
        ? liveControlFixturePayload({ sequence: 3, since: 0 })
        : liveControlFixturePayload({ sequence: 6, since: 3, events: [{ sequence: 5 }, { sequence: 6 }] }),
    }),
  });
  try {
    await assert.rejects(
      runLiveControlMonitor({
        ...parseLiveControlMonitorArguments([
          "--origin", fixture.origin,
          "--league", "1603083723",
          "--team", "6",
          "--polls", "2",
          "--interval-ms", "10",
          "--test-mode",
        ]),
      }),
      (error) => error?.code === "LIVE_CONTROL_EVENT_GAP",
    );
  } finally {
    await fixture.close();
  }
});

test("compact monitor bootstraps safely after the 256-event ring rolls over", async () => {
  const retainedEvents = maxRetainedLifecycleEvents();
  const fixture = await startLiveControlFixture({
    responder: ({ request, requestNumber }) => {
      const since = Number(new URL(request.url, "http://127.0.0.1").searchParams.get("since") || 0);
      return {
        status: 200,
        body: liveControlFixturePayload({
          sequence: requestNumber === 1 ? 300 : 301,
          since,
          events: requestNumber === 1 ? retainedEvents : undefined,
          overrides: {
            historicalAutopickDetected: true,
            uncontrolledRosterAdditionDetected: true,
            unattributedRosterCount: 2,
          },
        }),
      };
    },
  });
  try {
    const result = await runLiveControlMonitor({
      ...parseLiveControlMonitorArguments([
        "--origin", fixture.origin,
        "--league", "1603083723",
        "--team", "6",
        "--polls", "2",
        "--interval-ms", "10",
        "--test-mode",
      ]),
    });
    assert.equal(result.finalSequence, 301);
    assert.equal(result.eventsObserved, 257);
    assert.ok(result.maxBytes > 65_536, `expected a realistic retained window, received ${result.maxBytes} bytes`);
    assert.ok(result.maxBytes <= 131_072);
    assert.equal(result.bootstrap.truncated, true);
    assert.equal(result.bootstrap.earliestRetainedSequence, 45);
    assert.equal(result.safety.historicalAutopickDetected, true);
    assert.equal(result.safety.uncontrolledRosterAdditionDetected, true);
    assert.equal(result.safety.unattributedRosterCount, 2);
    assert.match(fixture.stats.urls[0], /since=0/);
    assert.match(fixture.stats.urls[1], /since=300/);
  } finally {
    await fixture.close();
  }
});

test("compact monitor requires strict event continuity after a truncated bootstrap", async () => {
  const fixture = await startLiveControlFixture({
    responder: ({ request, requestNumber }) => {
      const since = Number(new URL(request.url, "http://127.0.0.1").searchParams.get("since") || 0);
      return {
        status: 200,
        body: requestNumber === 1
          ? liveControlFixturePayload({ sequence: 300, since })
          : liveControlFixturePayload({ sequence: 302, since, events: [{ sequence: 302 }] }),
      };
    },
  });
  try {
    await assert.rejects(
      runLiveControlMonitor({
        ...parseLiveControlMonitorArguments([
          "--origin", fixture.origin,
          "--league", "1603083723",
          "--team", "6",
          "--polls", "2",
          "--interval-ms", "10",
          "--test-mode",
        ]),
      }),
      (error) => error?.code === "LIVE_CONTROL_EVENT_GAP",
    );
  } finally {
    await fixture.close();
  }
});

test("load probe bounds concurrency and proves read-only sequence stability", async () => {
  const options = parseLiveControlLoadArguments([
    "--fixture",
    "--requests", "64",
    "--concurrency", "4",
    "--max-duration-ms", "5000",
    "--p95-ms", "250",
    "--p99-ms", "500",
  ]);
  const result = await runLiveControlLoad(options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.completed, 64);
  assert.equal(result.baselineSequence, result.maxSequence);
  assert.deepEqual(result.fixture.methods, ["GET"]);
  assert.equal(result.fixture.requests, 65);
});

test("load probe accepts a max-retained rollover within 128KB and rejects a smaller explicit bound", async () => {
  const fixture = await startLiveControlFixture({ responder: rolledPublisherResponder() });
  try {
    const arguments_ = [
      "--origin", fixture.origin,
      "--league", "1603083723",
      "--team", "6",
      "--requests", "4",
      "--concurrency", "2",
      "--max-duration-ms", "5000",
      "--p95-ms", "250",
      "--p99-ms", "500",
      "--require-stable-sequence",
    ];
    const result = await runLiveControlLoad(parseLiveControlLoadArguments(arguments_));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.maxBytes > 65_536);
    assert.ok(result.maxBytes <= 131_072);
    assert.deepEqual([...new Set(fixture.stats.methods)], ["GET"]);

    await assert.rejects(
      runLiveControlLoad(parseLiveControlLoadArguments([...arguments_, "--max-bytes", "65536"])),
      (error) => error?.code === "LIVE_CONTROL_RESPONSE_TOO_LARGE",
    );
  } finally {
    await fixture.close();
  }
});

test("soak is explicit, parameterized, and capped at twenty thousand polls", () => {
  assert.throws(() => parseLiveControlSoakArguments([]), /--origin is required/);
  const threeHours = parseLiveControlSoakArguments([
    "--origin", "http://127.0.0.1:3000",
    "--league", "44050",
    "--team", "7",
    "--minutes", "180",
    "--interval-ms", "1000",
  ]);
  assert.equal(threeHours.polls, 10_800);
  assert.equal(threeHours.maxBytes, 131_072);
  assert.throws(() => parseLiveControlSoakArguments([
    "--fixture", "--max-bytes", "262145",
  ]), /must be 256-262144/);
  assert.throws(() => parseLiveControlSoakArguments([
    "--fixture", "--minutes", "240", "--interval-ms", "100",
  ]), /20000-poll resource bound/);
});

test("soak monitor accepts a max-retained rollover within 128KB and rejects a smaller explicit bound", async () => {
  const fixture = await startLiveControlFixture({ responder: rolledPublisherResponder() });
  try {
    const arguments_ = [
      "--origin", fixture.origin,
      "--league", "1603083723",
      "--team", "6",
      "--minutes", "0.01",
      "--interval-ms", "100",
      "--max-rss-mb", "2048",
      "--max-rss-growth-percent", "100",
    ];
    const result = await runLiveControlSoak(parseLiveControlSoakArguments(arguments_));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.monitor.maxBytes > 65_536);
    assert.ok(result.monitor.maxBytes <= 131_072);
    assert.deepEqual([...new Set(fixture.stats.methods)], ["GET"]);

    await assert.rejects(
      runLiveControlSoak(parseLiveControlSoakArguments([...arguments_, "--max-bytes", "65536"])),
      (error) => error?.code === "LIVE_CONTROL_RESPONSE_TOO_LARGE",
    );
  } finally {
    await fixture.close();
  }
});

test("chaos probe detects stale, hung, oversized, identity, session, regressed, reset, and failed status paths", async () => {
  const result = await runLiveControlChaosSuite();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cases.length, 9);
  assert.deepEqual(result.failures, []);
});
