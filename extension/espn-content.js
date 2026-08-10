function getContext() {
  const url = new URL(window.location.href);
  const text = document.body?.innerText ?? "";
  const nomineeNode = document.querySelector("[data-testid*='nominee' i], [class*='nominee' i], [aria-label*='nominated player' i]");
  const currentBidMatch = text.match(/current bid\s*\$?\s*(\d+)/i) || text.match(/high bid\s*\$?\s*(\d+)/i);
  const leagueMatch = window.location.href.match(/league(?:Id|\/)(?:=|\/)(\d+)/i);
  const teamMatch = window.location.href.match(/team(?:Id|\/)(?:=|\/)(\d+)/i);
  return {
    url: window.location.href,
    leagueId: url.searchParams.get("leagueId") || leagueMatch?.[1] || null,
    teamId: Number(url.searchParams.get("teamId") || teamMatch?.[1] || 0) || null,
    inDraftRoom: /draft/i.test(url.pathname) || /draft room|on the clock|nominate player/i.test(text),
    onClock: /you(?:'|’)re on the clock|your turn to (?:pick|nominate)|you are on the clock/i.test(text),
    auctionActive: /current bid|your bid|nominate player|salary cap/i.test(text),
    nominatedPlayer: nomineeNode?.textContent?.trim().replace(/\s+/g, " ") || null,
    currentBid: Number(currentBidMatch?.[1] || 0),
    leadingBid: /you(?:'|’)re (?:the )?(?:high bidder|winning)|your bid is winning/i.test(text),
  };
}

function findByText(selector, patterns) {
  return [...document.querySelectorAll(selector)].find((node) => {
    const label = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""}`.trim();
    return patterns.some((pattern) => pattern.test(label));
  });
}

function findPlayerNode(playerId, playerName) {
  const exact = document.querySelector(`[data-player-id="${CSS.escape(String(playerId))}"], [data-playerid="${CSS.escape(String(playerId))}"]`);
  if (exact) return exact;
  const normalized = playerName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [...document.querySelectorAll("button, [role='button'], tr, [data-testid], li")].find((node) =>
    (node.textContent || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(normalized)
  );
}

function setNativeValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function executeAction(action) {
  const context = getContext();
  if (!context.inDraftRoom) return { ok: false, code: "NOT_IN_DRAFT_ROOM", message: "Open the ESPN draft room first." };
  if (action.expectedLeagueId && String(context.leagueId) !== String(action.expectedLeagueId)) {
    return { ok: false, code: "WRONG_LEAGUE", message: "The open ESPN draft room is for a different league." };
  }
  if (action.requireOnClock !== false && !context.onClock && action.operation !== "BID") {
    return { ok: false, code: "NOT_ON_CLOCK", message: "ESPN does not show that you are on the clock." };
  }
  if (action.operation === "BID" && context.nominatedPlayer && !context.nominatedPlayer.toLowerCase().includes(action.playerName.toLowerCase())) {
    return { ok: false, code: "NOMINEE_MISMATCH", message: "The ESPN nominee no longer matches the recommended player." };
  }

  const playerNode = findPlayerNode(action.playerId, action.playerName);
  if (action.operation !== "BID" && !playerNode) {
    return { ok: false, code: "PLAYER_NOT_FOUND", message: `${action.playerName} is not visible in ESPN's available-player list.` };
  }

  playerNode?.scrollIntoView({ block: "center" });
  playerNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  await new Promise((resolve) => setTimeout(resolve, 350));

  if (action.amount) {
    const bidInput = findByText("input", [/bid/i, /amount/i, /salary/i]) || document.querySelector("input[type='number']");
    if (bidInput instanceof HTMLInputElement) setNativeValue(bidInput, String(action.amount));
  }

  const patterns = action.operation === "NOMINATE"
    ? [/^nominate$/i, /nominate player/i]
    : action.operation === "BID"
      ? [/^bid$/i, /place bid/i, /bid \$/i]
      : [/^draft$/i, /^select$/i, /draft player/i, /make pick/i];
  const submit = findByText("button, [role='button']", patterns);
  if (!submit) return { ok: false, code: "ACTION_NOT_FOUND", message: "The ESPN confirmation control was not found. ESPN may have changed its draft-room layout." };

  submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const dialog = document.querySelector("[role='dialog'], [aria-modal='true'], [class*='modal' i]");
  const confirmation = dialog && [...dialog.querySelectorAll("button, [role='button']")].find((node) =>
    /^(confirm|submit|yes)|confirm (pick|bid|nomination)|yes,? (draft|bid|nominate)/i.test((node.textContent || "").trim())
  );
  confirmation?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return { ok: true, code: "SUBMITTED", message: `${action.operation.toLowerCase()} submitted in ESPN.`, action };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DF_GET_CONTEXT") {
    sendResponse(getContext());
    return;
  }
  if (message?.type === "DF_EXECUTE_ACTION") {
    executeAction(message.payload).then(sendResponse);
    return true;
  }
});

let previousState = "";
setInterval(() => {
  const context = getContext();
  const serialized = JSON.stringify(context);
  if (serialized !== previousState) {
    previousState = serialized;
    chrome.runtime.sendMessage({ type: "ESPN_CONTEXT", payload: context }).catch(() => {});
  }
  if (context.inDraftRoom && context.leagueId) {
    chrome.runtime.sendMessage({ type: "ESPN_POLL", payload: context }).catch(() => {});
  }
}, 2000);

chrome.runtime.sendMessage({ type: "ESPN_CONTEXT", payload: getContext() }).catch(() => {});
