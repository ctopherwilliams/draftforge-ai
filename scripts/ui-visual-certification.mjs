#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const chromeBinary = process.env.CHROME_BIN
  || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const baselinePath = resolve("tests/fixtures/ui-visual-baseline.json");
const outputDirectory = resolve("outputs/ui-regression/latest");
const visualBaselineSchemaVersion = 2;
const visualHashAlgorithm = "chrome-canvas-high-dhash-9x8-bt601-v1";
const visualHashThreshold = 10;
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

async function perceptualHash(client, screenshotBase64, expectedWidth, expectedHeight) {
  const evaluated = await client.call("Runtime.evaluate", {
    expression: `(async () => {
      const encoded = ${JSON.stringify(screenshotBase64)};
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      try {
        if (bitmap.width !== ${expectedWidth} || bitmap.height !== ${expectedHeight}) {
          throw new Error('screenshot dimensions do not match the certified viewport');
        }
        const canvas = document.createElement('canvas');
        canvas.width = 9;
        canvas.height = 8;
        const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        if (!context) throw new Error('2d canvas unavailable');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, 9, 8);
        const rgba = context.getImageData(0, 0, 9, 8).data;
        if (rgba.length !== 288) throw new Error('unexpected perceptual-hash pixel count');
        const gray = [];
        for (let offset = 0; offset < rgba.length; offset += 4) {
          gray.push(Math.round((rgba[offset] * 299 + rgba[offset + 1] * 587 + rgba[offset + 2] * 114) / 1000));
        }
        if (gray.length !== 72) throw new Error('unexpected perceptual-hash luminance count');
        let hash = 0n;
        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            hash = (hash << 1n) | BigInt(gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
          }
        }
        return hash.toString(16).padStart(16, '0');
      } finally {
        bitmap.close();
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const hash = evaluated?.result?.value;
  if (evaluated?.exceptionDetails || !/^[0-9a-f]{16}$/.test(hash || "")) {
    throw new Error("browser could not compute the screenshot perceptual hash");
  }
  return hash;
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

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function terminate(child, { processGroup = false } = {}) {
  if (!child) return;
  const ownsProcessGroup = processGroup && process.platform !== "win32";
  const alive = () => ownsProcessGroup
    ? processGroupAlive(child.pid)
    : child.exitCode === null && child.signalCode === null;
  const signal = (name) => {
    try {
      if (ownsProcessGroup) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const waitForStop = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (alive() && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    return !alive();
  };
  if (!alive()) return;
  signal("SIGTERM");
  if (await waitForStop(3000)) return;
  signal("SIGKILL");
  if (!await waitForStop(3000)) throw new Error(`failed to terminate child process ${child.pid}`);
}

async function closeBrowser(client) {
  if (!client) return;
  let timeout;
  try {
    await Promise.race([
      client.call("Browser.close"),
      new Promise((resolveWait) => { timeout = setTimeout(resolveWait, 2000); }),
    ]);
  } catch {
    // The browser may close its debugging socket before acknowledging.
  } finally {
    clearTimeout(timeout);
    client.close();
  }
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
let certificationError;
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
  ], {
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
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
    results[scenario.name] = {
      hash: await perceptualHash(client, screenshot.data, scenario.width, scenario.height),
      metrics,
      screenshot: screenshotPath,
    };
  }

  const generated = {
    schemaVersion: visualBaselineSchemaVersion,
    hashAlgorithm: visualHashAlgorithm,
    threshold: visualHashThreshold,
    scenarios: Object.fromEntries(Object.entries(results).map(([name, result]) => {
      const scenario = scenarios.find((candidate) => candidate.name === name);
      return [name, { width: scenario.width, height: scenario.height, hash: result.hash }];
    })),
  };
  if (printBaseline) {
    process.stdout.write(`${JSON.stringify(generated, null, 2)}\n`);
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (baseline.schemaVersion !== visualBaselineSchemaVersion
      || baseline.hashAlgorithm !== visualHashAlgorithm
      || baseline.threshold !== visualHashThreshold) {
      throw new Error("visual baseline schema or hash algorithm mismatch");
    }
    const expectedScenarioNames = scenarios.map(({ name }) => name).sort();
    const baselineScenarioNames = Object.keys(baseline.scenarios || {}).sort();
    if (JSON.stringify(baselineScenarioNames) !== JSON.stringify(expectedScenarioNames)) {
      throw new Error("visual baseline scenario set mismatch");
    }
    for (const scenario of scenarios) {
      const expected = baseline.scenarios[scenario.name];
      if (expected?.width !== scenario.width
        || expected?.height !== scenario.height
        || !/^[0-9a-f]{16}$/.test(expected?.hash || "")) {
        throw new Error(`visual baseline scenario is malformed: ${scenario.name}`);
      }
    }
    const changes = Object.entries(results).map(([name, result]) => ({
      name,
      distance: hamming(result.hash, baseline.scenarios[name].hash),
      screenshot: result.screenshot,
    }));
    const regressions = changes.filter((change) => change.distance > visualHashThreshold);
    if (regressions.length) throw new Error(`visual regression threshold exceeded: ${JSON.stringify(regressions)}`);
    process.stdout.write(`${JSON.stringify({ ok: true, code: "UI_VISUAL_CERTIFIED", changes }, null, 2)}\n`);
  }
} catch (error) {
  certificationError = error;
}

const cleanupErrors = [];
try { await closeBrowser(client); } catch (error) { cleanupErrors.push(error); }
try { await terminate(chromeProcess, { processGroup: true }); } catch (error) { cleanupErrors.push(error); }
try { await terminate(serverProcess); } catch (error) { cleanupErrors.push(error); }
if (temporaryDirectory) {
  try {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
}
const errors = [certificationError, ...cleanupErrors].filter(Boolean);
if (errors.length === 1) throw errors[0];
if (errors.length > 1) {
  throw new AggregateError(errors, "visual certification and cleanup both failed");
}
