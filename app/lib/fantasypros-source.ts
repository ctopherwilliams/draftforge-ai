import { normalizePlayerName, type IntelligencePlayer, type IntelligenceSource } from "./consensus.ts";

export const FANTASYPROS_MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_JSON_CHARS = 2 * 1024 * 1024;
const MAX_EXPERTS = 2_000;
const MIN_EXPERTS = 10;
const MAX_PLAYERS = 2_000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const SOURCE_INFO = {
  id: "fantasypros" as const,
  name: "FantasyPros Expert Consensus Rankings",
  kind: "composite" as const,
  weight: .20,
  attribution: "FantasyPros Expert Consensus Rankings",
};

// Verified against the public rankings page's positionUrls.ALL mapping.
const PROFILES = {
  Standard: { scoring: "STD", path: "consensus-cheatsheets.php" },
  "Half PPR": { scoring: "HALF", path: "half-point-ppr-cheatsheets.php" },
  PPR: { scoring: "PPR", path: "ppr-cheatsheets.php" },
} as const;

function profileFor(scoring: string, season: number) {
  if (!Object.hasOwn(PROFILES, scoring)) throw new Error("FANTASYPROS_SCORING_UNSUPPORTED");
  if (!Number.isSafeInteger(season) || season < 2000 || season > 2100) {
    throw new Error("FANTASYPROS_SEASON_INVALID");
  }
  return PROFILES[scoring as keyof typeof PROFILES];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`FANTASYPROS_${label}_INVALID`);
  }
  return value as Record<string, unknown>;
}

/** Extract only literal JSON; never evaluate provider JavaScript. */
function assignment(html: string, name: string) {
  const pattern = new RegExp(`^[\\t ]*(?:var|let|const)\\s+${name}\\s*=\\s*`, "gm");
  const match = pattern.exec(html);
  if (!match) throw new Error(`FANTASYPROS_${name}_MISSING`);
  const start = pattern.lastIndex;
  if (pattern.exec(html)) throw new Error(`FANTASYPROS_${name}_DUPLICATE`);
  if (html[start] !== "{") throw new Error(`FANTASYPROS_${name}_JSON_INVALID`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < Math.min(html.length, start + MAX_JSON_CHARS); index += 1) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > 64) throw new Error("FANTASYPROS_JSON_DEPTH_EXCEEDED");
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        let after = index + 1;
        while (after < html.length && /\s/.test(html[after])) after += 1;
        if (html[after] !== ";") throw new Error(`FANTASYPROS_${name}_JSON_INVALID`);
        try {
          return object(JSON.parse(html.slice(start, index + 1)), name);
        } catch {
          throw new Error(`FANTASYPROS_${name}_JSON_INVALID`);
        }
      }
    }
  }
  throw new Error(`FANTASYPROS_${name}_JSON_UNTERMINATED_OR_TOO_LARGE`);
}

function integer(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function timestamp(value: unknown, referenceMs: number, label: string) {
  const seconds = integer(value);
  if (seconds === null || seconds <= 0 || seconds > 8_640_000_000_000) {
    throw new Error(`FANTASYPROS_${label}_TIMESTAMP_INVALID`);
  }
  const ms = seconds * 1000;
  if (ms > referenceMs + MAX_FUTURE_MS) throw new Error(`FANTASYPROS_${label}_TIMESTAMP_FUTURE`);
  if (referenceMs - ms > MAX_AGE_MS) throw new Error(`FANTASYPROS_${label}_TIMESTAMP_STALE`);
  return ms;
}

/** Pure parser, with an explicit clock for deterministic freshness checks. */
export function parseFantasyProsHtml(html: string, scoring: string, season: number, referenceMs = Date.now()) {
  const profile = profileFor(scoring, season);
  if (!Number.isFinite(referenceMs)) throw new Error("FANTASYPROS_REFERENCE_TIME_INVALID");
  if (typeof html !== "string" || html.length > FANTASYPROS_MAX_HTML_BYTES
    || new TextEncoder().encode(html).byteLength > FANTASYPROS_MAX_HTML_BYTES) {
    throw new Error("FANTASYPROS_HTML_TOO_LARGE");
  }
  const ecr = assignment(html, "ecrData");
  const groups = assignment(html, "expertGroupsData");
  if (ecr.sport !== "NFL" || groups.sport !== "NFL"
    || ecr.ranking_type_name !== "draft" || groups.type !== "draft"
    || ecr.position_id !== "ALL" || groups.position !== "ALL"
    || integer(ecr.year) !== season || integer(groups.season) !== season
    || ecr.scoring !== profile.scoring || groups.scoring !== profile.scoring
    || integer(ecr.week) !== 0
    // The public expert-groups object has no week field: type=draft is its
    // season-long contract. If a week is supplied, it must agree with ECR.
    || (groups.week !== undefined && integer(groups.week) !== 0)) {
    throw new Error("FANTASYPROS_PROFILE_MISMATCH");
  }
  const boardMs = timestamp(ecr.last_updated_ts, referenceMs, "BOARD");
  if (typeof ecr.filters !== "string" || ecr.filters.length > 20_000) {
    throw new Error("FANTASYPROS_SELECTED_EXPERTS_INVALID");
  }
  const selected = ecr.filters.split(",").map((id) => integer(id.trim()));
  if (selected.length < MIN_EXPERTS || selected.length > MAX_EXPERTS
    || selected.some((id) => id === null || id === 0)
    || new Set(selected).size !== selected.length
    || integer(ecr.total_experts) !== selected.length) {
    throw new Error("FANTASYPROS_SELECTED_EXPERTS_INVALID");
  }
  if (!Array.isArray(groups.expert_data) || groups.expert_data.length > MAX_EXPERTS) {
    throw new Error("FANTASYPROS_EXPERT_DATA_INVALID");
  }
  const experts = new Map<number, Record<string, unknown>>();
  for (const raw of groups.expert_data) {
    const expert = object(raw, "EXPERT");
    const id = integer(expert.id);
    if (id === null || id === 0 || experts.has(id)) throw new Error("FANTASYPROS_EXPERT_ID_INVALID_OR_DUPLICATE");
    experts.set(id, expert);
  }
  let oldestMs = boardMs;
  for (const id of selected) {
    const expert = experts.get(id as number);
    if (!expert) throw new Error("FANTASYPROS_SELECTED_EXPERT_MISSING");
    oldestMs = Math.min(oldestMs, timestamp(expert.last_updated, referenceMs, "EXPERT"));
  }
  // When present, this second provider declaration must describe the same
  // selected cohort; neither available nor default experts prove selection.
  if (ecr.experts_available !== undefined) {
    const available = object(ecr.experts_available, "EXPERTS_AVAILABLE");
    if (!Array.isArray(available.included)) throw new Error("FANTASYPROS_INCLUDED_EXPERTS_MISMATCH");
    const included = available.included.map(integer);
    if (included.length !== selected.length || new Set(included).size !== included.length
      || included.some((id) => !selected.includes(id))) throw new Error("FANTASYPROS_INCLUDED_EXPERTS_MISMATCH");
  }
  if (!Array.isArray(ecr.players) || ecr.players.length < 25 || ecr.players.length > MAX_PLAYERS
    || integer(ecr.count) !== ecr.players.length) throw new Error("FANTASYPROS_PLAYER_COUNT_INVALID");
  const playerIds = new Set<number>();
  const ranks = new Set<number>();
  const positions = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
  const identities = new Map<string, Array<{ id: number; player: IntelligencePlayer }>>();
  const parsedPlayers: IntelligencePlayer[] = ecr.players.map((raw) => {
    const player = object(raw, "PLAYER");
    const id = integer(player.player_id);
    const rank = integer(player.rank_ecr);
    if (id === null || id === 0 || playerIds.has(id)) throw new Error("FANTASYPROS_PLAYER_ID_INVALID_OR_DUPLICATE");
    if (rank === null || rank === 0 || rank > MAX_PLAYERS || ranks.has(rank)) throw new Error("FANTASYPROS_PLAYER_RANK_INVALID_OR_DUPLICATE");
    if (typeof player.player_name !== "string" || !player.player_name.trim() || player.player_name.length > 200
      || typeof player.player_team_id !== "string" || player.player_team_id.length > 10
      || typeof player.player_position_id !== "string" || !positions.has(player.player_position_id)) {
      throw new Error("FANTASYPROS_PLAYER_INVALID");
    }
    playerIds.add(id);
    ranks.add(rank);
    const parsed = { name: player.player_name.trim(), team: player.player_team_id.trim().toUpperCase(), pos: player.player_position_id, rank };
    const identity = `${normalizePlayerName(parsed.name)}|${parsed.pos}`;
    const members = identities.get(identity) || [];
    members.push({ id, player: parsed });
    identities.set(identity, members);
    return parsed;
  });
  const excludedAmbiguousIdentities: Array<{ identity: string; playerIds: number[]; teams: string[] }> = [];
  const excludedPlayers = new Set<IntelligencePlayer>();
  for (const [identity, members] of identities) {
    if (members.length < 2) continue;
    const teams = members.map(({ player }) => player.team);
    // The public board contains distinct provider people with the same name
    // and position (e.g. Isaiah Williams NYJ/FA). Our downstream identity lacks
    // provider IDs, so exclude EVERY member rather than guess which one fits.
    // Unique IDs/ranks were validated above. Same-team or unproven-team
    // duplicates remain corruption and must fail closed, never be deduplicated.
    if (teams.some((team) => !team) || new Set(teams).size !== teams.length) {
      throw new Error("FANTASYPROS_DUPLICATE_PLAYER_IDENTITY");
    }
    excludedAmbiguousIdentities.push({ identity, playerIds: members.map(({ id }) => id), teams });
    for (const { player } of members) excludedPlayers.add(player);
  }
  const players = parsedPlayers.filter((player) => !excludedPlayers.has(player));
  if (players.length < 25) throw new Error("FANTASYPROS_UNAMBIGUOUS_PLAYER_COUNT_TOO_SMALL");
  return { players, updatedAt: new Date(oldestMs).toISOString(), sampleSize: selected.length, excludedAmbiguousIdentities };
}

/** Bound both decoded response bytes and the complete fetch/body deadline. */
export async function fetchFantasyProsHtml(url: string, request: typeof fetch = fetch, timeoutMs = 15_000): Promise<string> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error("FANTASYPROS_TIMEOUT_INVALID");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("FANTASYPROS_FETCH_TIMEOUT"));
      controller.abort();
    }, timeoutMs);
  });
  const read = async () => {
    const response = await request(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { Accept: "text/html", "User-Agent": "DraftForge/0.1" },
    });
    reader = response.body?.getReader();
    if (controller.signal.aborted) {
      // A custom transport may deliver headers after the deadline has already
      // settled. Dispose that late body too; the outer cleanup ran earlier.
      void reader?.cancel().catch(() => undefined);
      throw new Error("FANTASYPROS_FETCH_TIMEOUT");
    }
    if (!response.ok) throw new Error(`FANTASYPROS_HTTP_${response.status}`);
    if (!/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get("content-type") || "")) {
      throw new Error("FANTASYPROS_CONTENT_TYPE_INVALID");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > FANTASYPROS_MAX_HTML_BYTES)) {
      throw new Error("FANTASYPROS_HTML_TOO_LARGE");
    }
    if (!reader) throw new Error("FANTASYPROS_BODY_MISSING");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw new Error("FANTASYPROS_FETCH_TIMEOUT");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > FANTASYPROS_MAX_HTML_BYTES) throw new Error("FANTASYPROS_HTML_TOO_LARGE");
      if (chunks.length >= 65_536) throw new Error("FANTASYPROS_BODY_CHUNK_LIMIT_EXCEEDED");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancellation must not extend the deadline if a transport is stalled.
    void reader?.cancel().catch(() => undefined);
  }
}

export async function fetchFantasyPros(scoring: string, season: number): Promise<IntelligenceSource> {
  const retrievedAt = new Date().toISOString();
  let url = "https://www.fantasypros.com/nfl/rankings/";
  try {
    const profile = profileFor(scoring, season);
    url += profile.path;
    const html = await fetchFantasyProsHtml(url);
    const { players, updatedAt, sampleSize } = parseFantasyProsHtml(html, scoring, season, Date.now());
    return { ...SOURCE_INFO, status: "ok", retrievedAt, url, players, updatedAt, sampleSize };
  } catch (error) {
    return { ...SOURCE_INFO, status: "error", retrievedAt, url, updatedAt: null, players: [],
      error: error instanceof Error ? error.message : String(error) };
  }
}
