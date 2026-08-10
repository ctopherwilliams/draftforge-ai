# DraftForge ESPN Companion

This Manifest V3 Chrome extension is the authenticated bridge between the DraftForge control room and ESPN Fantasy. It reads league data using the user's existing ESPN browser session and never sends ESPN cookies to DraftForge.

## Local install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `extension` directory.
4. Sign in to ESPN and open the league or live draft room in one tab.
5. Open DraftForge in another tab and choose **Import from ESPN**.

## Safety model

- Read access is limited to ESPN Fantasy endpoints.
- Draft actions are sent only when the ESPN draft room is open.
- Auto-Draft must be explicitly enabled in DraftForge.
- The content script refuses snake selections when ESPN does not show the user on the clock.
- If ESPN changes its draft-room markup, the action fails closed and reports an error instead of clicking an unknown control.

ESPN's fantasy API and draft-room markup are undocumented and can change without notice. Validate the companion against an ESPN mock draft before relying on it in a live league.
