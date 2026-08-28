#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { startLiveControlFixture } from "./live-control-fixture.mjs";
import { normalizeLoopbackOrigin, runLiveControlMonitor } from "./live-control-monitor.mjs";

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be ${minimum}-${maximum}`);
  return parsed;
}

function finite(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be ${minimum}-${maximum}`);
  return parsed;
}

export function parseLiveControlSoakArguments(argv) {
  const values = new Map();
  let fixture = false;
  const allowed = new Set([
    "--origin", "--league", "--team", "--minutes", "--interval-ms", "--timeout-ms",
    "--max-rss-mb", "--max-rss-growth-percent",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--fixture") fixture = true;
    else if (allowed.has(argument)) {
      if (!argv[index + 1]) throw new Error(`${argument} requires a value`);
      values.set(argument, argv[index + 1]);
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (!fixture && !values.has("--origin")) throw new Error("--origin is required unless --fixture is explicit");
  const leagueId = String(values.get("--league") || (fixture ? "1603083723" : ""));
  if (!/^\d{1,20}$/.test(leagueId)) throw new Error("--league must be an exact numeric ESPN league id");
  const minutes = finite(values.get("--minutes") || 180, "--minutes", .01, 240);
  const intervalMs = integer(values.get("--interval-ms") || 1_000, "--interval-ms", 100, 60_000);
  const polls = Math.max(1, Math.floor(minutes * 60_000 / intervalMs));
  if (polls > 20_000) throw new Error("soak configuration exceeds the 20000-poll resource bound");
  return {
    fixture,
    origin: values.has("--origin") ? normalizeLoopbackOrigin(values.get("--origin")) : null,
    leagueId,
    teamId: integer(values.get("--team") || (fixture ? 6 : NaN), "--team", 1, 10_000),
    minutes,
    polls,
    intervalMs,
    timeoutMs: integer(values.get("--timeout-ms") || 1_000, "--timeout-ms", 50, 10_000),
    maxRssMb: finite(values.get("--max-rss-mb") || 300, "--max-rss-mb", 16, 2_048),
    maxRssGrowthPercent: finite(values.get("--max-rss-growth-percent") || 10, "--max-rss-growth-percent", 0, 100),
  };
}

export async function runLiveControlSoak(options, { signal } = {}) {
  const fixture = options.fixture ? await startLiveControlFixture() : null;
  const processStartRss = process.memoryUsage().rss;
  let baselineRss = processStartRss;
  let peakRss = processStartRss;
  try {
    // Prime fetch, connection pooling, JSON parsing, and the compact schema
    // before establishing the leak baseline. Otherwise a very short smoke run
    // measures ordinary one-time Node initialization as memory growth.
    await runLiveControlMonitor({
      origin: fixture?.origin || options.origin,
      leagueId: options.leagueId,
      teamId: options.teamId,
      polls: 20,
      intervalMs: Math.min(options.intervalMs, 100),
      timeoutMs: options.timeoutMs,
      maxBytes: 16_384,
      maxContextAgeMs: 1_000,
      maxPickAgeMs: 2_500,
      maxSourceAgeMs: 900_000,
      quiet: true,
    }, { signal });
    baselineRss = process.memoryUsage().rss;
    peakRss = baselineRss;
    const monitor = await runLiveControlMonitor({
      origin: fixture?.origin || options.origin,
      leagueId: options.leagueId,
      teamId: options.teamId,
      polls: options.polls,
      intervalMs: options.intervalMs,
      timeoutMs: options.timeoutMs,
      maxBytes: 16_384,
      maxContextAgeMs: 1_000,
      maxPickAgeMs: 2_500,
      maxSourceAgeMs: 900_000,
      quiet: true,
    }, {
      signal,
      onSample() {
        const rss = process.memoryUsage().rss;
        peakRss = Math.max(peakRss, rss);
      },
    });
    const endRss = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, baselineRss, endRss);
    const growthPercent = baselineRss > 0 ? ((peakRss - baselineRss) / baselineRss) * 100 : 0;
    const peakRssMb = peakRss / 1024 / 1024;
    const ok = monitor.ok && peakRssMb <= options.maxRssMb && growthPercent <= options.maxRssGrowthPercent;
    return {
      ok,
      code: ok ? "LIVE_CONTROL_SOAK_PASSED" : "LIVE_CONTROL_SOAK_FAILED",
      configuredMinutes: options.minutes,
      monitor,
      memory: {
        processStartRssMb: processStartRss / 1024 / 1024,
        baselineRssMb: baselineRss / 1024 / 1024,
        endRssMb: endRss / 1024 / 1024,
        peakRssMb,
        growthPercent,
        maxRssMb: options.maxRssMb,
        maxGrowthPercent: options.maxRssGrowthPercent,
      },
      scope: "monitor-process; collect server and Chrome RSS separately during authenticated certification",
    };
  } finally {
    await fixture?.close();
  }
}

async function main() {
  let options;
  try {
    options = parseLiveControlSoakArguments(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: "USAGE",
      message: error instanceof Error ? error.message : String(error),
      usage: "npm run test:soak -- --origin http://127.0.0.1:3000 --league <id> --team <id> [--minutes 180]",
    }));
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("LIVE_CONTROL_SOAK_INTERRUPTED"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runLiveControlSoak(options, { signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: "LIVE_CONTROL_SOAK_FAILED", message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
