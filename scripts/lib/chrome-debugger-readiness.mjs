import { readFile } from "node:fs/promises";

function diagnosticSuffix(child, stderr) {
  const exit = child?.exitCode ?? "running";
  const signal = child?.signalCode ?? "none";
  const tail = String(stderr?.() || "<empty>").slice(-4000);
  return `Chrome exit=${exit}; signal=${signal}; stderr=${tail}`;
}

async function fetchBefore(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`debugger request exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...options, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForChromeDebuggerTarget({
  child,
  activePortFile,
  origin,
  timeoutMs = 30_000,
  pollIntervalMs = 100,
  readFileImpl = readFile,
  fetchImpl = fetch,
  now = Date.now,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  stderr = () => "",
}) {
  const deadlineAt = now() + timeoutMs;
  let lastProblem = "DevToolsActivePort is not available";

  while (now() < deadlineAt) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`isolated Chrome exited before debugger readiness; ${diagnosticSuffix(child, stderr)}`);
    }
    if (child?.signalCode) {
      throw new Error(`isolated Chrome was signaled before debugger readiness; ${diagnosticSuffix(child, stderr)}`);
    }

    try {
      const content = await readFileImpl(activePortFile, "utf8");
      const portText = content.split(/\r?\n/)[0]?.trim() || "";
      if (!/^\d+$/.test(portText)) throw new Error("DevToolsActivePort did not contain a numeric port");
      const debuggerPort = Number(portText);
      if (!Number.isSafeInteger(debuggerPort) || debuggerPort < 1 || debuggerPort > 65_535) {
        throw new Error("DevToolsActivePort was outside the TCP port range");
      }

      let remainingMs = deadlineAt - now();
      if (remainingMs <= 0) break;
      const versionResponse = await fetchBefore(
        fetchImpl,
        `http://127.0.0.1:${debuggerPort}/json/version`,
        {},
        remainingMs,
      );
      if (!versionResponse.ok) throw new Error(`debugger version endpoint returned HTTP ${versionResponse.status}`);

      remainingMs = deadlineAt - now();
      if (remainingMs <= 0) break;
      const targetResponse = await fetchBefore(
        fetchImpl,
        `http://127.0.0.1:${debuggerPort}/json/new?${encodeURIComponent(origin)}`,
        { method: "PUT" },
        remainingMs,
      );
      if (!targetResponse.ok) throw new Error(`debugger target endpoint returned HTTP ${targetResponse.status}`);
      const target = await targetResponse.json();
      if (!target?.webSocketDebuggerUrl) throw new Error("debugger target omitted its WebSocket URL");
      return { debuggerPort, target };
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }

    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) break;
    await delay(Math.min(pollIntervalMs, remainingMs));
  }

  throw new Error(
    `timed out waiting for isolated Chrome debugger; last=${lastProblem}; ${diagnosticSuffix(child, stderr)}`,
  );
}
