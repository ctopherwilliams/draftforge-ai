import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeDraftDayLoopbackOrigin,
  parseDraftDayAuditArguments,
  parseDraftDayDoctorArguments,
  parseDraftDayReadyArguments,
} from "../scripts/draft-day-cli-lib.mjs";

test("draft-day gates accept only exact loopback HTTP origins", () => {
  assert.equal(normalizeDraftDayLoopbackOrigin(undefined), "http://127.0.0.1:3000");
  assert.equal(normalizeDraftDayLoopbackOrigin("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(normalizeDraftDayLoopbackOrigin("http://[::1]:3000"), "http://[::1]:3000");
  for (const origin of [
    "https://127.0.0.1:3000",
    "http://192.168.1.10:3000",
    "http://user:pass@127.0.0.1:3000",
    "http://127.0.0.1:3000/private",
    "http://127.0.0.1:3000/?proof=false",
    "http://127.0.0.1:3000/#proof",
    "http://127.0.0.1:3000/?",
    "http://127.0.0.1:3000/#",
    " http://127.0.0.1:3000",
    "",
    "http://127.0.0.1:3000@attacker.example",
    "not-a-url",
  ]) assert.throws(() => normalizeDraftDayLoopbackOrigin(origin), /MUST_BE_LOOPBACK_HTTP/, origin);
});

test("doctor arguments reject unknown, duplicate, and malformed options before any request", () => {
  assert.deepEqual(parseDraftDayDoctorArguments([
    "--format", "snake",
    "--phase", "live",
    "--origin", "http://127.0.0.1:3000",
    "--league", "123",
    "--team", "7",
    "--timer", "30",
    "--no-start-server",
  ]), {
    format: "snake",
    phase: "live",
    origin: "http://127.0.0.1:3000",
    startServer: false,
    league: "123",
    team: "7",
    timer: "30",
  });
  assert.throws(() => parseDraftDayDoctorArguments(["--format", "snake", "--unknown", "x"]), /UNKNOWN_ARGUMENT/);
  assert.throws(() => parseDraftDayDoctorArguments(["--format", "snake", "--format", "salary-cap"]), /DUPLICATE_ARGUMENT/);
  assert.throws(() => parseDraftDayDoctorArguments(["--format", "--phase", "live"]), /ARGUMENT_VALUE_REQUIRED/);
  assert.throws(() => parseDraftDayDoctorArguments(["--no-start-server", "--no-start-server"]), /DUPLICATE_ARGUMENT/);
  assert.throws(() => parseDraftDayDoctorArguments(["--format", "snake", "--origin", "https://localhost:3000"]), /MUST_BE_LOOPBACK/);
});

test("ready and completion audit share the same strict argument and origin boundary", () => {
  assert.equal(parseDraftDayReadyArguments(["--format", "salary-cap"]).origin, "http://127.0.0.1:3000");
  assert.deepEqual(parseDraftDayAuditArguments([
    "--league", "123",
    "--team", "7",
    "--require-complete",
  ]), {
    leagueId: "123",
    teamId: 7,
    origin: "http://127.0.0.1:3000",
    requireComplete: true,
  });
  for (const parse of [parseDraftDayReadyArguments, parseDraftDayAuditArguments]) {
    assert.throws(() => parse(["--origin", "http://attacker.example:3000"]), /MUST_BE_LOOPBACK/);
    assert.throws(() => parse(["--origin", "http://localhost:3000", "--origin", "http://127.0.0.1:3000"]), /DUPLICATE_ARGUMENT/);
    assert.throws(() => parse(["--future-option", "true"]), /UNKNOWN_ARGUMENT/);
  }
  assert.throws(() => parseDraftDayAuditArguments(["--require-complete", "--require-complete"]), /DUPLICATE_ARGUMENT/);
});
