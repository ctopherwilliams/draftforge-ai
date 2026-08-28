const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function normalizeDraftDayLoopbackOrigin(value) {
  const raw = value === undefined ? "http://127.0.0.1:3000" : String(value);
  let url;
  try {
    if (!raw || raw !== raw.trim()) throw new Error("invalid origin bytes");
    url = new URL(raw);
  } catch {
    throw new Error("DRAFT_DAY_ORIGIN_MUST_BE_LOOPBACK_HTTP");
  }
  if (url.protocol !== "http:"
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || !["", "/"].includes(url.pathname)
    || url.search
    || url.hash
    || url.href !== `${url.origin}/`) {
    throw new Error("DRAFT_DAY_ORIGIN_MUST_BE_LOOPBACK_HTTP");
  }
  return url.origin;
}

export function parseStrictCliOptions(argv, { valueOptions = [], flagOptions = [] } = {}) {
  const allowedValues = new Set(valueOptions);
  const allowedFlags = new Set(flagOptions);
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (allowedFlags.has(argument)) {
      if (flags.has(argument)) throw new Error(`DUPLICATE_ARGUMENT:${argument}`);
      flags.add(argument);
      continue;
    }
    if (!allowedValues.has(argument)) throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    if (values.has(argument)) throw new Error(`DUPLICATE_ARGUMENT:${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`ARGUMENT_VALUE_REQUIRED:${argument}`);
    }
    values.set(argument, String(value));
    index += 1;
  }
  return { values, flags };
}

export function parseDraftDayDoctorArguments(argv) {
  const { values, flags } = parseStrictCliOptions(argv, {
    valueOptions: ["--format", "--phase", "--origin", "--league", "--team", "--timer"],
    flagOptions: ["--no-start-server"],
  });
  return {
    format: values.get("--format") || "",
    phase: values.get("--phase") || "pre-room",
    origin: normalizeDraftDayLoopbackOrigin(values.get("--origin")),
    startServer: !flags.has("--no-start-server"),
    league: values.get("--league") || "",
    team: values.get("--team") || "",
    timer: values.get("--timer") || "",
  };
}

export function parseDraftDayReadyArguments(argv) {
  const { values } = parseStrictCliOptions(argv, {
    valueOptions: ["--format", "--phase", "--origin", "--max-age-ms"],
  });
  return {
    format: values.get("--format") || "",
    phase: values.get("--phase") || "pre-room",
    origin: normalizeDraftDayLoopbackOrigin(values.get("--origin")),
    maxAgeMs: Number(values.get("--max-age-ms") || "15000"),
  };
}

export function parseDraftDayAuditArguments(argv) {
  const { values, flags } = parseStrictCliOptions(argv, {
    valueOptions: ["--league", "--team", "--origin"],
    flagOptions: ["--require-complete"],
  });
  return {
    leagueId: values.get("--league") || "",
    teamId: Number(values.get("--team") || ""),
    origin: normalizeDraftDayLoopbackOrigin(values.get("--origin")),
    requireComplete: flags.has("--require-complete"),
  };
}
