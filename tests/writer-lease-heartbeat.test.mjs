import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  authenticatedImportRetiresLiveControl,
  writerLeaseHeartbeatAcknowledged,
  writerLeaseHeartbeatAllowed,
  writerLeaseHeartbeatSnapshotStillCurrent,
} from "../app/lib/live-control.ts";
import {
  renewExistingWriterLease,
  writerLeaseMatchesBinding,
} from "../extension/writer-lease.js";

test("writer lease heartbeats are gated to an exact active live-room binding", () => {
  assert.equal(writerLeaseHeartbeatAllowed(false, "", "44050:7:11"), false);
  assert.equal(writerLeaseHeartbeatAllowed(false, "44050:7:11", "44050:7:11"), false);
  assert.equal(writerLeaseHeartbeatAllowed(true, "44050:7:11", null), false);
  assert.equal(writerLeaseHeartbeatAllowed(true, "44050:7:11", "44050:7:12"), false);
  assert.equal(writerLeaseHeartbeatAllowed(true, "44050:7:11", "44050:7:11"), true);
});

test("out-of-order heartbeat responses cannot apply after rebound or control replacement", () => {
  assert.equal(writerLeaseHeartbeatSnapshotStillCurrent(
    true, "44050:7:12", "44050:7:12", "control-a", "44050:7:11", "control-a",
  ), false);
  assert.equal(writerLeaseHeartbeatSnapshotStillCurrent(
    true, "44050:7:11", "44050:7:11", "control-b", "44050:7:11", "control-a",
  ), false);
  assert.equal(writerLeaseHeartbeatSnapshotStillCurrent(
    true, "44050:7:11", "44050:7:11", "control-a", "44050:7:11", "control-a",
  ), true);
});

test("every pre-room import retires live control even when ESPN reuses league or tab identity", () => {
  assert.equal(authenticatedImportRetiresLiveControl("44050", "44050", false), true);
  assert.equal(authenticatedImportRetiresLiveControl("44050", "44050", undefined), true);
  assert.equal(authenticatedImportRetiresLiveControl("44050", "44050", true), false);
  assert.equal(authenticatedImportRetiresLiveControl("44050", "99999", true), true);
});

test("an expired writer lease cannot be renewed or reused", () => {
  const binding = { appTabId: 11, commandCenterSessionId: "session-a", commandCenterDocumentId: "document-a" };
  const lease = {
    leaseId: "lease-a",
    appTabId: 11,
    commandCenterSessionId: "session-a",
    commandCenterDocumentId: "document-a",
    bindingGeneration: 4,
    expiresAt: 2_500,
  };
  assert.equal(writerLeaseMatchesBinding(lease, binding, 4, 2_499), true);
  assert.equal(writerLeaseMatchesBinding(lease, binding, 4, 2_500), false);
  assert.deepEqual(renewExistingWriterLease(lease, binding, 4, 2_000, 1_500), {
    ...lease,
    expiresAt: 3_500,
  });
  assert.equal(renewExistingWriterLease(lease, binding, 4, 2_500, 1_500), null);
  assert.equal(renewExistingWriterLease(null, binding, 4, 2_000, 1_500), null);
});

test("a delayed heartbeat success is accepted only while its authoritative lease remains live", () => {
  assert.equal(writerLeaseHeartbeatAcknowledged(true, 2_001, 2_000), true);
  assert.equal(writerLeaseHeartbeatAcknowledged(true, 2_000, 2_000), false);
  assert.equal(writerLeaseHeartbeatAcknowledged(false, 3_000, 2_000), false);
  assert.equal(writerLeaseHeartbeatAcknowledged(true, Number.NaN, 2_000), false);
});

test("the dashboard consumes writer-heartbeat results before generic command failures", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const dedicated = source.indexOf('payload?.commandType === "WRITER_HEARTBEAT"');
  const generic = source.indexOf('type === "COMMAND_RESULT" && payload?.ok === false');
  const heartbeatBranch = source.slice(dedicated, generic);
  assert.ok(dedicated >= 0, "dedicated writer-heartbeat result handling is required");
  assert.ok(generic > dedicated, "writer-heartbeat results must not reach the generic connection-failure handler");
  assert.match(source, /writerLeaseHeartbeatAllowed\(\s*Boolean\(control\)/);
  assert.match(heartbeatBranch, /transitionRequestId/);
  assert.match(heartbeatBranch, /setAutoDraft\(false\)/);
  assert.doesNotMatch(heartbeatBranch, /failClosedLiveControl/);
  assert.match(source, /if \(writerHeartbeatPendingRef\.current\) return;/);
  assert.match(source, /pending\.timedOut = true;[\s\S]*?setAutoDraft\(false\)/);
  assert.match(heartbeatBranch, /pending\.failed = true;[\s\S]*?setAutoDraft\(false\)/);
  assert.match(heartbeatBranch, /pending\.failed = true;[\s\S]*?updateWriterLeaseHealth\(false\)/);
  assert.doesNotMatch(
    heartbeatBranch.slice(heartbeatBranch.indexOf("pending.failed = true")),
    /writerHeartbeatPendingRef\.current = null/,
  );
  const initializeLiveControl = source.slice(
    source.indexOf("const initializeLiveControl"),
    source.indexOf("const attributeLiveRosterPlayer"),
  );
  assert.ok(
    initializeLiveControl.indexOf("retirePendingWriterHeartbeat();")
      < initializeLiveControl.indexOf("if (liveControlRef.current)"),
    "a verified same-binding import must retire a paused heartbeat before the existing-control fast path",
  );
  assert.match(source, /retirePendingWriterHeartbeat\(\);\s*updateWriterLeaseHealth\(true\);\s*activeEspnTabRef\.current = reboundTabId/);
  assert.match(source, /label: "Exact ESPN writer heartbeat is current", ok: writerLeaseHealthy/);
  assert.match(source, /if \(!writerLeaseHealthyRef\.current\) return "WRITER_LEASE_UNHEALTHY"/);
  assert.match(source, /acceptLiveProducerContext\(roomContext\)[\s\S]*?if \(writerLeaseHealthyRef\.current\) setExtension\("connected"\)/);
  const timeoutBranch = source.slice(
    source.indexOf("pending.timeoutId = window.setTimeout"),
    source.indexOf("writerHeartbeatPendingRef.current = pending"),
  );
  assert.ok(
    timeoutBranch.indexOf("writerLeaseHeartbeatSnapshotStillCurrent(")
      < timeoutBranch.indexOf("updateWriterLeaseHealth(false)"),
    "a stale timeout cannot poison a verified replacement writer lease",
  );
  assert.match(source, /authenticatedImportRetiresLiveControl\([\s\S]*?importedContext\?\.inDraftRoom/);
  assert.match(background, /message\.type === "WRITER_HEARTBEAT"[\s\S]*?transitionRequestId[\s\S]*?WRITER_LEASE_RENEWED/);
  const submitBlock = background.slice(
    background.indexOf('if (message.type === "SUBMIT_ACTION")'),
    background.indexOf('if (message.type === "DISABLE_ESPN_AUTOPICK")'),
  );
  assert.match(submitBlock, /currentWriterLease\(submittedBinding, sender\.tab\?\.id\)/);
  assert.doesNotMatch(submitBlock, /renewWriterLease\(submittedBinding\)/);
});
