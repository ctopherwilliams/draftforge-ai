import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function profileProcessIds(profilePath) {
  if (!profilePath || process.platform === "win32") return [];
  const { stdout } = await execFile("ps", ["-axo", "pid=,command="], { maxBuffer: 1024 * 1024 });
  const profileArgument = `--user-data-dir=${profilePath}`;
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match && match[2].includes(profileArgument) ? [Number(match[1])] : [];
  }).filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
}

export async function terminateProfileProcesses(profilePath, {
  listProcessIds = profileProcessIds,
  killProcess = process.kill.bind(process),
  sleep = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  termTimeoutMs = 3000,
  killTimeoutMs = 3000,
  pollIntervalMs = 50,
  platform = process.platform,
} = {}) {
  if (!profilePath || platform === "win32") return;
  const waitForExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let remaining = await listProcessIds(profilePath);
    while (remaining.length && Date.now() < deadline) {
      await sleep(pollIntervalMs);
      remaining = await listProcessIds(profilePath);
    }
    return remaining;
  };
  let remaining = await listProcessIds(profilePath);
  for (const pid of remaining) {
    try { killProcess(pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  remaining = await waitForExit(termTimeoutMs);
  for (const pid of remaining) {
    try { killProcess(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  remaining = await waitForExit(killTimeoutMs);
  if (remaining.length) throw new Error(`failed to terminate exact visual-certification Chrome processes: ${remaining.join(",")}`);
}
