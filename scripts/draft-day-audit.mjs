import {
  clearLiveCodeFreezeAfterAudit,
  inspectReleaseRevision,
} from "./live-code-freeze-lib.mjs";
import { parseDraftDayAuditArguments } from "./draft-day-cli-lib.mjs";

let cli;
try {
  cli = parseDraftDayAuditArguments(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: "USAGE",
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exit(2);
}
const { leagueId, teamId, origin, requireComplete } = cli;
if (requireComplete && (!/^\d{1,20}$/.test(leagueId) || !Number.isInteger(teamId) || teamId <= 0)) {
  console.error(JSON.stringify({ ok: false, code: "USAGE", message: "--require-complete requires exact --league and --team" }));
  process.exit(2);
}
const query = leagueId && Number.isInteger(teamId) && teamId > 0
  ? `?leagueId=${encodeURIComponent(leagueId)}&teamId=${teamId}`
  : "";

let response;
try {
  response = await fetch(`${origin}/api/draft-day${query}`, { headers: { Accept: "application/json" } });
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "DRAFT_AUDIT_UNREACHABLE", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}

const result = await response.json().catch(() => ({ ok: false, code: `HTTP_${response.status}` }));
if (!response.ok || result.ok !== true || (requireComplete && result.evaluation?.finalReady !== true)) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

let liveCodeFreeze = null;
if (requireComplete) {
  try {
    const release = inspectReleaseRevision();
    liveCodeFreeze = clearLiveCodeFreezeAfterAudit({
      requestedLeagueId: leagueId,
      requestedTeamId: teamId,
      auditProof: result,
      currentRevision: release.revision,
    });
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error instanceof Error ? error.message : "LIVE_CODE_FREEZE_COMPLETION_CLEAR_FAILED",
      audit: result,
    }, null, 2));
    process.exit(1);
  }
}

console.log(JSON.stringify({ ...result, liveCodeFreeze }, null, 2));
