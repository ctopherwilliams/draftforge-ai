const args = process.argv.slice(2);
const valueFor = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
};

const leagueId = valueFor("--league");
const teamId = Number(valueFor("--team"));
const origin = valueFor("--origin", "http://127.0.0.1:3000").replace(/\/$/, "");
const requireComplete = args.includes("--require-complete");
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
console.log(JSON.stringify(result, null, 2));
if (!response.ok || result.ok !== true || (requireComplete && result.evaluation?.finalReady !== true)) process.exit(1);
