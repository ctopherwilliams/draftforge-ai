#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const chromeBinary = process.env.CHROME_BIN
  || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const baselinePath = resolve("tests/fixtures/ui-visual-baseline.json");
const outputDirectory = resolve("outputs/ui-regression/latest");
const printBaseline = process.argv.includes("--print-baseline");
const scenarios = [
  { name: "pre-room-desktop", format: null, width: 1440, height: 1000 },
  { name: "snake-desktop", format: "Snake", width: 1440, height: 1000 },
  { name: "salary-desktop", format: "Salary cap", width: 1440, height: 1000 },
  { name: "snake-wide", format: "Snake", width: 1728, height: 1000 },
  { name: "salary-wide", format: "Salary cap", width: 1728, height: 1000 },
  { name: "snake-ultrawide", format: "Snake", width: 2560, height: 1200 },
  { name: "salary-ultrawide", format: "Salary cap", width: 2560, height: 1200 },
  { name: "pre-room-mobile", format: null, width: 390, height: 844 },
  { name: "snake-mobile", format: "Snake", width: 390, height: 844 },
  { name: "salary-mobile", format: "Salary cap", width: 390, height: 844 },
];

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // Expected while the temporary server or browser is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

class CdpClient {
  constructor(url) {
    this.sequence = 0;
    this.pending = new Map();
    this.socket = new WebSocket(url);
  }

  async connect() {
    await new Promise((resolveConnect, reject) => {
      this.socket.addEventListener("open", resolveConnect, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    return this;
  }

  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

function perceptualHash(path) {
  const pixels = execFileSync("ffmpeg", [
    "-v", "error", "-i", path, "-vf", "scale=9:8,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ]);
  if (pixels.length < 72) throw new Error(`could not decode screenshot ${path}`);
  let value = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      value = (value << 1n) | BigInt(pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? 1 : 0);
    }
  }
  return value.toString(16).padStart(16, "0");
}

function hamming(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const auditExpression = `(() => {
  const visible = (node) => { const style = getComputedStyle(node); const box = node.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0; };
  const elements = [...document.querySelectorAll('button, a, input, select')].filter(visible);
  const unnamed = elements.filter((node) => !(node.getAttribute('aria-label') || node.textContent || node.getAttribute('placeholder') || '').trim());
  const undersized = elements.filter((node) => { const hitTarget = node.tagName === 'INPUT' && node.closest('label') ? node.closest('label') : node; const box = hitTarget.getBoundingClientRect(); return node.tagName !== 'A' && (box.height < 43 || box.width < 43); });
  const ids = [...document.querySelectorAll('[id]')].map((node) => node.id).filter(Boolean);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const panelSelectors = ['.coach-column', '.players-panel', '.roster-panel'];
  const panels = panelSelectors.map((selector) => document.querySelector(selector)).filter(Boolean).map((node) => ({ selector: panelSelectors.find((item) => node.matches(item)), box: node.getBoundingClientRect() }));
  const overlaps = [];
  for (let left = 0; left < panels.length; left += 1) for (let right = left + 1; right < panels.length; right += 1) {
    const a = panels[left].box; const b = panels[right].box;
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push([panels[left].selector, panels[right].selector]);
  }
  const progress = document.querySelector('[role="progressbar"]');
  return {
    title: document.title,
    viewportWidth: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    unnamedControls: unnamed.length,
    undersizedControls: undersized.map((node) => (node.textContent || node.getAttribute('aria-label') || node.tagName).trim()).slice(0, 10),
    duplicateIds,
    panelCount: panels.length,
    overlaps,
    progressValid: Boolean(progress && progress.getAttribute('aria-valuemin') !== null && progress.getAttribute('aria-valuemax') !== null && progress.getAttribute('aria-valuenow') !== null),
    mainLandmarks: document.querySelectorAll('main').length,
    h1Count: document.querySelectorAll('h1').length,
  };
})()`;

let serverProcess;
let chromeProcess;
let client;
let temporaryDirectory;
try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  temporaryDirectory = await mkdtemp(join(tmpdir(), "draftforge-ui-cert-"));
  await mkdir(outputDirectory, { recursive: true });
  // The production entrypoint intentionally forbids caller-controlled ports
  // and requires a clean, upstream-synchronized release. Visual certification
  // runs against the artifact built by its own npm lifecycle instead, on an
  // isolated ephemeral loopback port that can never displace port 3000.
  serverProcess = spawn(process.execPath, [
    resolve("node_modules/vinext/dist/cli.js"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverErrors = "";
  serverProcess.stderr.on("data", (chunk) => { serverErrors += String(chunk).slice(-4000); });
  await waitFor(async () => (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok, 20_000, `DraftForge server (${serverErrors})`);

  chromeProcess = spawn(chromeBinary, [
    "--headless=new",
    "--mute-audio",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${temporaryDirectory}`,
    "about:blank",
  ], { stdio: "ignore" });
  const activePortFile = join(temporaryDirectory, "DevToolsActivePort");
  const debuggerPort = await waitFor(async () => {
    const content = await readFile(activePortFile, "utf8");
    return Number(content.split(/\r?\n/)[0]) || null;
  }, 10_000, "isolated Chrome debugger");
  const target = await fetch(`http://127.0.0.1:${debuggerPort}/json/new?${encodeURIComponent(origin)}`, { method: "PUT" }).then((response) => response.json());
  client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await waitFor(async () => {
    const result = await client.call("Runtime.evaluate", {
      expression: `(() => { const button = document.querySelector('.preview-formats button'); return document.readyState === 'complete' && Boolean(button) && Object.keys(button).some((key) => key.startsWith('__reactProps')); })()`,
      returnByValue: true,
    });
    return result.result.value;
  }, 15_000, "rendered preview controls");

  const results = {};
  for (const scenario of scenarios) {
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: scenario.width,
      height: scenario.height,
      deviceScaleFactor: 1,
      mobile: scenario.width < 600,
    });
    await client.call("Page.navigate", { url: origin });
    await waitFor(async () => {
      const result = await client.call("Runtime.evaluate", {
        expression: `(() => { const button = document.querySelector('.preview-formats button'); return document.readyState === 'complete' && Boolean(button) && Object.keys(button).some((key) => key.startsWith('__reactProps')); })()`,
        returnByValue: true,
      });
      return result.result.value;
    }, 15_000, `${scenario.name} hydrated preview controls`);
    if (scenario.format) {
      const clicked = await client.call("Runtime.evaluate", {
        expression: `(() => { const button = [...document.querySelectorAll('.preview-formats button')].find((node) => node.textContent.trim() === ${JSON.stringify(scenario.format)}); if (!button) return false; button.click(); return true; })()`,
        returnByValue: true,
      });
      if (!clicked.result.value) throw new Error(`${scenario.name}: preview control was not available`);
      await waitFor(async () => {
        const result = await client.call("Runtime.evaluate", { expression: "!document.querySelector('.setup-drawer') && Boolean(document.querySelector('.coach-column'))", returnByValue: true });
        return result.result.value;
      }, 5000, `${scenario.format} command center`);
    } else {
      await waitFor(async () => {
        const result = await client.call("Runtime.evaluate", { expression: "Boolean(document.querySelector('.setup-drawer .connect-card'))", returnByValue: true });
        return result.result.value;
      }, 5000, `${scenario.name} setup drawer`);
    }
    await client.call("Runtime.evaluate", {
      expression: `(() => { let style = document.getElementById('visual-cert-style'); if (!style) { style = document.createElement('style'); style.id = 'visual-cert-style'; document.head.append(style); } style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; return document.fonts.ready; })()`,
      awaitPromise: true,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    const audit = await client.call("Runtime.evaluate", { expression: auditExpression, returnByValue: true });
    const metrics = audit.result.value;
    const failures = [
      metrics.horizontalOverflow && "horizontal overflow",
      metrics.unnamedControls && `${metrics.unnamedControls} unnamed controls`,
      metrics.undersizedControls.length && `undersized controls: ${metrics.undersizedControls.join(", ")}`,
      metrics.duplicateIds.length && `duplicate IDs: ${metrics.duplicateIds.join(", ")}`,
      metrics.panelCount !== 3 && `expected 3 command panels, found ${metrics.panelCount}`,
      metrics.overlaps.length && `panel overlaps: ${JSON.stringify(metrics.overlaps)}`,
      !metrics.progressValid && "invalid progressbar semantics",
      metrics.mainLandmarks !== 1 && `expected one main landmark, found ${metrics.mainLandmarks}`,
      !/DraftForge AI/.test(metrics.title) && "missing DraftForge title",
    ].filter(Boolean);
    if (failures.length) throw new Error(`${scenario.name}: ${failures.join("; ")}`);
    const screenshot = await client.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    const screenshotPath = join(outputDirectory, `${scenario.name}.png`);
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    results[scenario.name] = { hash: perceptualHash(screenshotPath), metrics, screenshot: screenshotPath };
  }

  const generated = { schemaVersion: 1, scenarios: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { hash: result.hash }])) };
  if (printBaseline) {
    process.stdout.write(`${JSON.stringify(generated, null, 2)}\n`);
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    const changes = Object.entries(results).map(([name, result]) => ({
      name,
      distance: hamming(result.hash, baseline.scenarios?.[name]?.hash || "0000000000000000"),
      screenshot: result.screenshot,
    }));
    const regressions = changes.filter((change) => change.distance > 10);
    if (regressions.length) throw new Error(`visual regression threshold exceeded: ${JSON.stringify(regressions)}`);
    process.stdout.write(`${JSON.stringify({ ok: true, code: "UI_VISUAL_CERTIFIED", changes }, null, 2)}\n`);
  }
} finally {
  client?.close();
  await terminate(chromeProcess);
  await terminate(serverProcess);
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
