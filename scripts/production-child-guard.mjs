import { inspectProductionSupervision } from "./production-supervision-lib.mjs";

const statePath = String(process.env.DRAFTFORGE_PRODUCTION_SUPERVISION_PATH || "");
const expectedToken = String(process.env.DRAFTFORGE_PRODUCTION_SUPERVISION_TOKEN || "");
const expectedSupervisorPid = Number(process.env.DRAFTFORGE_PRODUCTION_SUPERVISOR_PID);
const startupDeadline = Date.now() + 1_500;

function guard() {
  const result = inspectProductionSupervision({
    statePath,
    listenerPids: [process.pid],
  });
  const exact = result.ok
    && result.state.token === expectedToken
    && Number(result.state.supervisorPid) === expectedSupervisorPid
    && Number(result.state.childPid) === process.pid;
  if (!exact && Date.now() >= startupDeadline) process.exit(70);
}

guard();
const interval = setInterval(guard, 400);
interval.unref?.();
