const APP_SOURCE = "draftforge-web";
const EXTENSION_SOURCE = "draftforge-extension";

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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type?.startsWith("DF_")) publish(message.type, message.payload ?? {});
});

announceReady();
