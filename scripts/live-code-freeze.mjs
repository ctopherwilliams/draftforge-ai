#!/usr/bin/env node

import {
  defaultLiveCodeFreezePath,
  emergencyClearLiveCodeFreeze,
  emergencyConfirmationFor,
  evaluateCodeFreezeCheck,
  evaluateProductionReleaseState,
  inspectLocalFrozenArtifact,
  inspectReleaseRevision,
  readLiveCodeFreeze,
} from "./live-code-freeze-lib.mjs";

const rawArgs = process.argv.slice(2);
const command = rawArgs.shift() || "status";

function usage(message = "invalid command") {
  console.error(JSON.stringify({
    ok: false,
    code: "USAGE",
    message,
    usage: [
      "npm run draft-day:freeze -- status",
      "npm run draft-day:freeze -- check --operation start|build|test|dev|extension-package|source-refresh",
      "npm run draft-day:freeze -- clear --league SOURCE_LEAGUE --team TEAM --room LIVE_ROOM --emergency-reason REASON --confirm-emergency TOKEN",
    ],
  }));
  process.exit(2);
}

function parseOptions(names) {
  const parsed = new Map();
  for (let index = 0; index < rawArgs.length; index += 2) {
    const name = rawArgs[index];
    const value = rawArgs[index + 1];
    if (!names.has(name) || value === undefined || value.startsWith("--") || parsed.has(name)) {
      usage("invalid, missing, or duplicate option");
    }
    parsed.set(name, value);
  }
  return parsed;
}

const statePath = defaultLiveCodeFreezePath();
try {
  if (command === "check") {
    const options = parseOptions(new Set(["--operation"]));
    if (options.size !== 1 || !options.has("--operation")) usage("check requires exactly --operation");
    const release = inspectReleaseRevision();
    const freeze = readLiveCodeFreeze(statePath);
    let currentArtifact;
    if (options.get("--operation") === "start") {
      const releaseState = evaluateProductionReleaseState(release);
      if (!releaseState.ok) {
        console.log(JSON.stringify({ ...releaseState, freeze }));
        process.exit(73);
      }
      try {
        currentArtifact = inspectLocalFrozenArtifact(process.cwd(), release.revision);
      } catch (error) {
        console.log(JSON.stringify({
          ok: false,
          code: "LIVE_CODE_FREEZE_ARTIFACT_UNVERIFIED",
          cause: error instanceof Error ? error.message : "LIVE_CODE_FREEZE_ARTIFACT_INVALID",
          freeze,
        }));
        process.exit(73);
      }
    }
    const result = evaluateCodeFreezeCheck({
      freeze,
      operation: options.get("--operation"),
      currentRevision: release.revision,
      currentRelease: release,
      currentArtifact,
    });
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 73);
  }

  if (command === "clear") {
    const options = parseOptions(new Set([
      "--league",
      "--team",
      "--room",
      "--emergency-reason",
      "--confirm-emergency",
    ]));
    if (options.size !== 5) usage("emergency clear requires every identity, reason, and confirmation option");
    const result = emergencyClearLiveCodeFreeze({
      statePath,
      leagueId: options.get("--league"),
      teamId: Number(options.get("--team")),
      roomId: options.get("--room"),
      emergencyReason: options.get("--emergency-reason"),
      confirmation: options.get("--confirm-emergency"),
    });
    console.log(JSON.stringify({ ok: true, ...result }));
    process.exit(0);
  }

  if (command === "status") {
    if (rawArgs.length) usage("status accepts no options");
    const freeze = readLiveCodeFreeze(statePath);
    console.log(JSON.stringify({
      ok: true,
      code: freeze ? "LIVE_CODE_FREEZE_ACTIVE" : "LIVE_CODE_FREEZE_INACTIVE",
      freeze,
      emergencyConfirmation: freeze ? emergencyConfirmationFor(freeze) : null,
    }));
    process.exit(0);
  }

  // There is intentionally no manual arm command. Only the exact successful
  // live phase of draft-day-doctor may create the freeze.
  usage("unknown command");
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error instanceof Error ? error.message : "LIVE_CODE_FREEZE_FAILED" }));
  process.exit(1);
}
