import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runLiveControlChaosSuite } from "../scripts/live-control-chaos.mjs";
import { liveControlFixturePayload, startLiveControlFixture } from "../scripts/live-control-fixture.mjs";
import { parseLiveControlLoadArguments, runLiveControlLoad } from "../scripts/live-control-load.mjs";
import { parseLiveControlSoakArguments } from "../scripts/live-control-soak.mjs";
import {
  normalizeLoopbackOrigin,
  parseLiveControlMonitorArguments,
  runLiveControlMonitor,
} from "../scripts/live-control-monitor.mjs";

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
  assert.equal(options.maxBytes, 16_384);
});

test("release gate enforces the documented low-latency budgets", async () => {
  const source = await readFile(new URL("../scripts/live-control-release-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /"--p95-ms", "25"/);
  assert.match(source, /"--p99-ms", "50"/);
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
  assert.throws(() => parseLiveControlSoakArguments([
    "--fixture", "--minutes", "240", "--interval-ms", "100",
  ]), /20000-poll resource bound/);
});

test("chaos probe detects stale, hung, oversized, identity, session, regressed, reset, and failed status paths", async () => {
  const result = await runLiveControlChaosSuite();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cases.length, 9);
  assert.deepEqual(result.failures, []);
});
