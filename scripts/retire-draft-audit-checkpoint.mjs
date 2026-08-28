#!/usr/bin/env node

import { productionListenerPids } from "./build-production.mjs";
import {
  DRAFT_AUDIT_CHECKPOINT_RETIRE_CONFIRMATION,
  retirePersistedDraftAuditCheckpoint,
} from "../app/lib/draft-audit-checkpoint-store.ts";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

try {
  if (productionListenerPids().length) throw new Error("DRAFT_AUDIT_CHECKPOINT_RETIRE_SERVER_RUNNING");
  const leagueId = argument("league");
  const teamId = Number(argument("team"));
  const expectedDigest = argument("digest");
  const confirmation = argument("confirm");
  const result = await retirePersistedDraftAuditCheckpoint({
    leagueId,
    teamId,
    expectedDigest,
    confirmation,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error instanceof Error ? error.message : "DRAFT_AUDIT_CHECKPOINT_RETIRE_FAILED",
    requiredConfirmation: DRAFT_AUDIT_CHECKPOINT_RETIRE_CONFIRMATION,
  })}\n`);
  process.exitCode = 1;
}
