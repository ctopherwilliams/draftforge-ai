export const DRAFTFORGE_APP_ORIGINS = Object.freeze([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://draftforge-ai.workspace-231977.chatgpt.site",
]);

const APP_MESSAGE_TYPES = new Set([
  "RELOAD_EXTENSION",
  "APP_HELLO",
  "GET_RUNTIME_DIAGNOSTICS",
  "REFRESH_ESPN_CONTEXT",
  "CONNECT_ESPN",
  "SUBMIT_ACTION",
  "DISABLE_ESPN_AUTOPICK",
]);

const ESPN_MESSAGE_TYPES = new Set([
  "ESPN_CONTEXT",
  "ESPN_HEARTBEAT",
  "ESPN_ACTION_RESOLVED",
  "ESPN_ACTION_SUBMITTED",
]);

const ESPN_ORIGIN = "https://fantasy.espn.com";

function originFor(url) {
  try { return new URL(url).origin; }
  catch { return ""; }
}

export function isLocalDraftForgeSenderUrl(url) {
  return ["http://localhost:3000", "http://127.0.0.1:3000"].includes(originFor(url));
}

export function authorizeRuntimeMessage(type, senderUrl) {
  if (!APP_MESSAGE_TYPES.has(type) && !ESPN_MESSAGE_TYPES.has(type)) {
    return { ok: false, code: "UNKNOWN_MESSAGE" };
  }
  const origin = originFor(senderUrl);
  if (APP_MESSAGE_TYPES.has(type)) {
    return DRAFTFORGE_APP_ORIGINS.includes(origin)
      ? { ok: true, senderKind: "app" }
      : { ok: false, code: "APP_ORIGIN_FORBIDDEN" };
  }
  return origin === ESPN_ORIGIN
    ? { ok: true, senderKind: "espn" }
    : { ok: false, code: "ESPN_ORIGIN_FORBIDDEN" };
}
