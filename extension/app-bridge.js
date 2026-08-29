const APP_SOURCE = "draftforge-web";
const EXTENSION_SOURCE = "draftforge-extension";
let latestWriterBinding = null;

function publish(type, payload = {}) {
  window.postMessage({ source: EXTENSION_SOURCE, type, payload }, window.location.origin);
}

function announceReady() {
  chrome.runtime.sendMessage({ type: "APP_HELLO" }).then((response) => {
    publish("EXTENSION_READY", response ?? { ready: true });
  }).catch(() => {});
}

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.source !== APP_SOURCE) return;

  const payload = event.data.payload ?? {};
  if (typeof payload.commandCenterSessionId === "string"
    && payload.commandCenterSessionId
    && typeof payload.commandCenterDocumentId === "string"
    && payload.commandCenterDocumentId
    && Number.isInteger(Number(payload.expectedTabId))
    && String(payload.expectedLeagueId || "")
    && Number.isInteger(Number(payload.expectedTeamId))) {
    latestWriterBinding = {
      commandCenterSessionId: payload.commandCenterSessionId,
      commandCenterDocumentId: payload.commandCenterDocumentId,
      expectedLeagueId: String(payload.expectedLeagueId),
      expectedTeamId: Number(payload.expectedTeamId),
      expectedTabId: Number(payload.expectedTabId),
    };
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: event.data.type,
      payload: event.data.payload ?? {},
    });
    if (event.data.type === "APP_HELLO") {
      publish("EXTENSION_READY", response ?? { ready: true });
    } else if (response) {
      publish("COMMAND_RESULT", { ...response, commandType: event.data.type });
    }
  } catch (error) {
    publish("EXTENSION_ERROR", { message: error instanceof Error ? error.message : String(error) });
  }
});

function revokeWriterOnDocumentExit() {
  if (!latestWriterBinding) return;
  try {
    chrome.runtime.sendMessage({
      type: "REVOKE_WRITER_ON_PAGEHIDE",
      payload: latestWriterBinding,
    }).catch(() => {});
  } catch {
    // The background lease expires independently if the extension itself was
    // reloaded and no longer accepts this document's message.
  }
}

window.addEventListener("pagehide", revokeWriterOnDocumentExit);
window.addEventListener("beforeunload", revokeWriterOnDocumentExit);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type?.startsWith("DF_")) publish(message.type, message.payload ?? {});
});

announceReady();
