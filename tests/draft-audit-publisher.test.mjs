import assert from "node:assert/strict";
import test from "node:test";

import {
  createDraftAuditPublisher,
  draftAuditPublicationDigest,
  draftAuditPublisherBindingKey,
} from "../app/lib/draft-audit-publisher.ts";

const binding = {
  commandCenterSessionId: "command-center-session",
  liveControlSessionId: "live-control-session",
  leagueId: "1900344304",
  teamId: 7,
  tabId: 44,
};

function publication(digest, decisionId = null, authorizationKey = decisionId) {
  return {
    digest,
    capturedAt: "2026-08-28T00:00:00.000Z",
    decisionId,
    authorizationKey,
    binding,
    snapshot: { digest, decisionId },
  };
}

function recorded(candidate, overrides = {}) {
  return {
    ok: true,
    status: 200,
    code: "DRAFT_AUDIT_RECORDED",
    recordedPublication: {
      digest: candidate.digest,
      capturedAt: candidate.capturedAt,
      decisionId: candidate.decisionId,
      binding: candidate.binding,
      ...overrides,
    },
  };
}

test("publisher binding includes writer, live-control session, league, team, and tab", () => {
  const key = draftAuditPublisherBindingKey(binding);
  assert.equal(key, "command-center-session|live-control-session|1900344304|7|44");
  assert.equal(draftAuditPublisherBindingKey({ ...binding, tabId: 0 }), null);
  assert.equal(draftAuditPublisherBindingKey({ ...binding, liveControlSessionId: "bad session" }), null);
});

test("successful DRAFT_AUDIT_RECORDED ack authorizes only its exact lease and decision", async () => {
  let now = 10_000;
  const publisher = createDraftAuditPublisher({
    now: () => now,
    retryDelaysMs: [],
    post: async (candidate, signal) => {
      assert.equal(signal.aborted, false);
      return recorded(candidate);
    },
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-success-0001", "decision-44"));
  await publisher.flush();

  assert.equal(publisher.isAuthorized(binding), true);
  assert.equal(publisher.isAuthorized(binding, "decision-44"), true);
  assert.equal(publisher.isAuthorized(binding, "decision-45"), false);
  assert.equal(publisher.isAuthorized({ ...binding, tabId: 45 }), false);
  now += 12_001;
  assert.equal(publisher.isAuthorized(binding), false, "expired ack cannot authorize an ESPN action");
});

test("publisher rejects a success code that does not echo the exact stored publication", async () => {
  const losses = [];
  const publisher = createDraftAuditPublisher({
    retryDelaysMs: [],
    post: async (candidate) => recorded(candidate, { capturedAt: "2026-08-28T00:00:01.000Z" }),
    onAuthorizationLost: (failure) => losses.push(failure),
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-mismatched-ack", "decision-no-click"));
  await publisher.flush();

  assert.equal(publisher.isAuthorized(binding, "decision-no-click"), false);
  assert.equal(publisher.enqueue(publication("digest-after-bad-ack", "decision-no-click")), false);
  assert.equal(losses.at(-1)?.code, "DRAFT_AUDIT_ACK_MISMATCH");
  assert.equal(losses.at(-1)?.permanent, true);
});

test("exact snapshot publication digest is deterministic and content-sensitive", () => {
  const first = { capturedAt: "2026-08-28T00:00:00.000Z", decision: { id: "decision-1" } };
  assert.equal(draftAuditPublicationDigest(first), draftAuditPublicationDigest({ ...first }));
  assert.notEqual(draftAuditPublicationDigest(first), draftAuditPublicationDigest({ ...first, decision: { id: "decision-2" } }));
});

test("delayed and never-resolving POSTs abort and leave zero action authorization", async () => {
  for (const mode of ["delayed", "never"]) {
    let aborted = false;
    const publisher = createDraftAuditPublisher({
      timeoutMs: 100,
      retryDelaysMs: [],
      post: async (candidate, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        if (mode === "delayed") {
          setTimeout(() => resolve(recorded(candidate)), 175);
        }
      }),
    });
    publisher.bind(binding);
    publisher.enqueue(publication(`digest-${mode}-0001`, "decision-timeout"));
    await publisher.flush();
    assert.equal(aborted, true, `${mode} transport received AbortSignal`);
    assert.equal(publisher.isAuthorized(binding), false, `${mode} transport cannot authorize an action`);
  }
});

test("a timed-out POST settles before a queued successor starts", async () => {
  const events = [];
  let activePosts = 0;
  let maximumActivePosts = 0;
  let postIndex = 0;
  const publisher = createDraftAuditPublisher({
    timeoutMs: 100,
    abortSettlementGraceMs: 100,
    retryDelaysMs: [],
    post: async (candidate, signal) => {
      postIndex += 1;
      const currentIndex = postIndex;
      activePosts += 1;
      maximumActivePosts = Math.max(maximumActivePosts, activePosts);
      events.push(`start-${currentIndex}`);
      try {
        if (currentIndex === 1) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 500);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              setTimeout(() => {
                const error = new Error("abort unwind complete");
                error.name = "AbortError";
                reject(error);
              }, 10);
            }, { once: true });
          });
        }
        return recorded(candidate);
      } finally {
        events.push(`end-${currentIndex}`);
        activePosts -= 1;
      }
    },
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-times-out-first", null));
  publisher.enqueue(publication("digest-successor-exact", "decision-successor"));
  await publisher.flush();

  assert.equal(maximumActivePosts, 1);
  assert.deepEqual(events, ["start-1", "end-1", "start-2", "end-2"]);
  assert.equal(publisher.getAck()?.digest, "digest-successor-exact");
  assert.equal(publisher.isAuthorized(binding, "decision-successor"), true);
});

test("an abort-ignoring transport poisons the publisher without starting queued work", async () => {
  const losses = [];
  const seen = [];
  let activePosts = 0;
  let maximumActivePosts = 0;
  const publisher = createDraftAuditPublisher({
    timeoutMs: 100,
    abortSettlementGraceMs: 20,
    retryDelaysMs: [],
    post: async (candidate) => {
      seen.push(candidate.digest);
      activePosts += 1;
      maximumActivePosts = Math.max(maximumActivePosts, activePosts);
      await new Promise(() => {});
    },
    onAuthorizationLost: (failure) => losses.push(failure),
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-never-quiesces", null));
  publisher.enqueue(publication("digest-must-not-start", "decision-must-not-start"));
  await publisher.flush();

  assert.deepEqual(seen, ["digest-never-quiesces"]);
  assert.equal(activePosts, 1);
  assert.equal(maximumActivePosts, 1);
  assert.equal(publisher.isAuthorized(binding, "decision-must-not-start"), false);
  assert.equal(losses.at(-1)?.code, "DRAFT_AUDIT_POST_ABORT_UNSETTLED");
  assert.equal(losses.at(-1)?.permanent, true);

  const rebound = { ...binding, tabId: binding.tabId + 1 };
  assert.equal(publisher.bind(rebound), true);
  assert.equal(publisher.enqueue({
    ...publication("digest-after-rebind", "decision-after-rebind"),
    binding: rebound,
  }), false, "the same publisher instance cannot recover from indeterminate delivery");
  publisher.clear("TEST_CLEAR");
  publisher.bind(binding);
  assert.equal(publisher.enqueue(publication("digest-after-clear", "decision-after-clear")), false);
});

test("HTTP 409 clears a prior ack and permanently fences the bound publisher", async () => {
  let conflict = false;
  const publisher = createDraftAuditPublisher({
    retryDelaysMs: [],
    post: async (candidate) => conflict
      ? { ok: false, status: 409, code: "DRAFT_AUDIT_STALE_PUBLISHER" }
      : recorded(candidate),
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-before-conflict", null));
  await publisher.flush();
  assert.equal(publisher.isAuthorized(binding), true);

  conflict = true;
  publisher.enqueue(publication("digest-after-conflict-1", null));
  await publisher.flush();
  assert.equal(publisher.isAuthorized(binding), false);
  assert.equal(publisher.enqueue(publication("digest-after-conflict-2", null)), false);
});

test("authenticated import or exact-tab rebind clears the prior lease acknowledgment", async () => {
  const publisher = createDraftAuditPublisher({
    retryDelaysMs: [],
    post: async (candidate) => recorded(candidate),
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-original-room", null));
  await publisher.flush();
  assert.equal(publisher.isAuthorized(binding), true);

  const rebound = { ...binding, tabId: 45 };
  assert.equal(publisher.bind(rebound), true);
  assert.equal(publisher.isAuthorized(binding), false);
  assert.equal(publisher.isAuthorized(rebound), false, "new exact tab needs its own recorded ack");
  publisher.clear("AUTHENTICATED_IMPORT_STARTED");
  assert.equal(publisher.isAuthorized(rebound), false);
});

test("single-flight publisher coalesces obsolete work and records only the latest queued state", async () => {
  let releaseFirst;
  const seen = [];
  const publisher = createDraftAuditPublisher({
    retryDelaysMs: [],
    post: async (candidate) => {
      seen.push(candidate.digest);
      if (seen.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      return recorded(candidate);
    },
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-obsolete-01", "decision-old"));
  publisher.enqueue(publication("digest-current-0002", "decision-current"));
  releaseFirst();
  await publisher.flush();

  assert.deepEqual(seen, ["digest-obsolete-01", "digest-current-0002"]);
  assert.equal(publisher.getAck()?.digest, "digest-current-0002");
  assert.equal(publisher.isAuthorized(binding, "decision-current"), true);
  assert.equal(publisher.isAuthorized(binding, "decision-old"), false);
});

test("a failed obsolete publish retries only the latest queued snapshot", async () => {
  let releaseFirst;
  const seen = [];
  const publisher = createDraftAuditPublisher({
    retryDelaysMs: [0, 0],
    post: async (candidate) => {
      seen.push(candidate.digest);
      if (seen.length === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        return { ok: false, status: 503, code: "HTTP_503" };
      }
      return recorded(candidate);
    },
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-failed-old-1", "decision-old"));
  publisher.enqueue(publication("digest-latest-good", "decision-new"));
  releaseFirst();
  await publisher.flush();

  assert.deepEqual(seen, ["digest-failed-old-1", "digest-latest-good"]);
  assert.equal(publisher.isAuthorized(binding, "decision-new"), true);
});

test("an exact action waits for its matching current publication and never reuses an older ack", async () => {
  let releaseDecision;
  let holdDecision = false;
  const publisher = createDraftAuditPublisher({
    timeoutMs: 250,
    retryDelaysMs: [],
    post: async (candidate) => {
      if (holdDecision && candidate.decisionId === "decision-bid-2") {
        await new Promise((resolve) => { releaseDecision = resolve; });
      }
      return recorded(candidate);
    },
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-binding-ready", null));
  await publisher.flush();
  assert.equal(publisher.isAuthorized(binding), true);

  holdDecision = true;
  publisher.enqueue(publication("digest-exact-bid-02", "decision-bid-2"));
  assert.equal(publisher.isAuthorized(binding), false, "queued current state invalidates the older binding ack");
  assert.equal(publisher.isAuthorized(binding, "decision-bid-2"), false);
  const wait = publisher.waitUntilAuthorized(binding, "decision-bid-2", 200);
  setTimeout(() => releaseDecision(), 20);
  assert.equal(await wait, true);
  assert.equal(publisher.isAuthorized(binding, "decision-bid-2"), true);
});

test("a publish failure cancels the current authorization wait even if a later retry succeeds", async () => {
  let attempts = 0;
  const publisher = createDraftAuditPublisher({
    timeoutMs: 250,
    retryDelaysMs: [25],
    post: async (candidate) => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, status: 503, code: "HTTP_503" }
        : recorded(candidate);
    },
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-action-retry", "decision-action-retry"));
  assert.equal(await publisher.waitUntilAuthorized(binding, "decision-action-retry", 200), false);
  await publisher.flush();
  assert.equal(attempts, 2);
  assert.equal(publisher.isAuthorized(binding, "decision-action-retry"), true, "a future user action may use the recovered publisher");
});

test("clock-only snapshot churn cannot starve a protected exact-decision acknowledgement", async () => {
  const seen = [];
  const losses = [];
  let activePosts = 0;
  let maximumActivePosts = 0;
  let clockRevision = 0;
  const publisher = createDraftAuditPublisher({
    timeoutMs: 250,
    retryDelaysMs: [],
    post: async (candidate, signal) => {
      seen.push(candidate.digest);
      activePosts += 1;
      maximumActivePosts = Math.max(maximumActivePosts, activePosts);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, candidate.decisionId ? 70 : 150);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        return recorded(candidate);
      } finally {
        activePosts -= 1;
      }
    },
    onAuthorizationLost: (failure) => losses.push(failure),
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-clock-baseline", null));
  await publisher.flush();
  publisher.enqueue(publication("digest-decision-clock-0", "decision-snake-clock", "snake-authorization-key"));
  const churn = setInterval(() => {
    clockRevision += 1;
    publisher.enqueue(publication(
      `digest-decision-clock-${clockRevision}`,
      "decision-snake-clock",
      "snake-authorization-key",
    ));
  }, 5);
  const authorized = await publisher.waitUntilAuthorized(binding, "decision-snake-clock", 220);
  clearInterval(churn);

  assert.equal(authorized, true);
  assert.ok(clockRevision >= 5, `expected sustained clock churn, observed ${clockRevision} revisions`);
  assert.equal(publisher.isAuthorized(binding, "decision-snake-clock"), true);
  assert.equal(maximumActivePosts, 1);
  assert.deepEqual(losses, [], "prioritizing the decision must not report a transport authorization loss");
  assert.equal(seen[0], "digest-clock-baseline");
  await publisher.flush();
  assert.equal(publisher.isAuthorized(binding, "decision-snake-clock"), true);
});

test("a safety-key change fences an acknowledged decision even when its decision id is unchanged", async () => {
  let releaseChangedSafety;
  const publisher = createDraftAuditPublisher({
    timeoutMs: 250,
    retryDelaysMs: [],
    post: async (candidate) => {
      if (candidate.authorizationKey === "snake-safety-key-2") {
        await new Promise((resolve) => { releaseChangedSafety = resolve; });
      }
      return recorded(candidate);
    },
  });
  publisher.bind(binding);
  publisher.enqueue(publication("digest-snake-safe-1", "decision-snake-safety", "snake-safety-key-1"));
  await publisher.flush();
  assert.equal(publisher.isAuthorized(binding, "decision-snake-safety"), true);

  publisher.enqueue(publication("digest-snake-safe-2", "decision-snake-safety", "snake-safety-key-2"));
  assert.equal(publisher.isAuthorized(binding, "decision-snake-safety"), false);
  releaseChangedSafety();
  await publisher.flush();
  assert.equal(publisher.isAuthorized(binding, "decision-snake-safety"), true);

  publisher.enqueue(publication("digest-snake-cancelled", null));
  assert.equal(publisher.isAuthorized(binding, "decision-snake-safety"), false);
  await publisher.flush();
});
