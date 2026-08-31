export const DRAFTFORGE_LOCAL_APP_ORIGINS = Object.freeze([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

export const DRAFTFORGE_OBSERVER_ORIGINS = Object.freeze([
  "https://draftforge-ai.workspace-231977.chatgpt.site",
]);

export const DRAFTFORGE_APP_ORIGINS = Object.freeze([
  ...DRAFTFORGE_LOCAL_APP_ORIGINS,
  ...DRAFTFORGE_OBSERVER_ORIGINS,
]);

const APP_MESSAGE_TYPES = new Set([
  "RELOAD_EXTENSION",
  "RELOAD_EXACT_ESPN_TAB",
  "APP_HELLO",
  "GET_RUNTIME_DIAGNOSTICS",
  "ARM_LIVE_ROOM_WATCH",
  "CLOSE_PRACTICE_ROOM",
  "CLEAN_LOCAL_WORKSPACE",
  "RECOVER_LIVE_WORKSPACE",
  "REFRESH_ESPN_CONTEXT",
  "CONNECT_ESPN",
  "CANCEL_PENDING_ACTIONS",
  "REVOKE_ACTION_BINDING",
  "REVOKE_WRITER_ON_PAGEHIDE",
  "WRITER_HEARTBEAT",
  "SUBMIT_ACTION",
  "DISABLE_ESPN_AUTOPICK",
]);

const ESPN_MESSAGE_TYPES = new Set([
  "ESPN_CONTEXT",
  "ESPN_HEARTBEAT",
  "ESPN_ACTION_RESOLVED",
  "ESPN_ACTION_SUBMITTED",
  "VERIFY_ACTION_AUTHORIZATION",
  "AUCTION_CLICK_UNCERTAINTY",
]);

const ESPN_ORIGIN = "https://fantasy.espn.com";
const REMOTE_READ_ONLY_APP_MESSAGE_TYPES = new Set([
  "APP_HELLO",
  "GET_RUNTIME_DIAGNOSTICS",
]);

function originFor(url) {
  try { return new URL(url).origin; }
  catch { return ""; }
}

export function isLocalDraftForgeSenderUrl(url) {
  return DRAFTFORGE_LOCAL_APP_ORIGINS.includes(originFor(url));
}

export function authorizeRuntimeMessage(type, senderUrl) {
  if (!APP_MESSAGE_TYPES.has(type) && !ESPN_MESSAGE_TYPES.has(type)) {
    return { ok: false, code: "UNKNOWN_MESSAGE" };
  }
  const origin = originFor(senderUrl);
  if (APP_MESSAGE_TYPES.has(type)) {
    if (DRAFTFORGE_LOCAL_APP_ORIGINS.includes(origin)) return { ok: true, senderKind: "app" };
    if (DRAFTFORGE_OBSERVER_ORIGINS.includes(origin)) {
      return REMOTE_READ_ONLY_APP_MESSAGE_TYPES.has(type)
        ? { ok: true, senderKind: "app-observer" }
        : { ok: false, code: "APP_WRITER_ORIGIN_REQUIRED" };
    }
    return { ok: false, code: "APP_ORIGIN_FORBIDDEN" };
  }
  return origin === ESPN_ORIGIN
    ? { ok: true, senderKind: "espn" }
    : { ok: false, code: "ESPN_ORIGIN_FORBIDDEN" };
}
