# DraftForge ESPN Companion

This Manifest V3 Chrome extension is the authenticated bridge between the DraftForge control room and ESPN Fantasy. It reads league data using the user's existing ESPN browser session and never sends ESPN cookies to DraftForge.

## Local install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `extension` directory.
4. Sign in to ESPN and open the league or live draft room in one tab.
5. Open DraftForge in another tab and choose **Import from ESPN**.

For another league, open its ESPN page and choose **Import another ESPN league** in DraftForge. Each league keeps independent settings, picks, player data, and strategy. Opening a saved league's live draft room automatically switches DraftForge to that profile; Auto-Draft always remains off until explicitly re-enabled.

## Safety model

- Read access is limited to ESPN Fantasy endpoints.
- App commands are accepted only from localhost or the exact deployed DraftForge origin; sibling hosted sites are rejected.
- Draft actions are sent only when the ESPN draft room is open.
- Auto-Draft must be explicitly enabled in DraftForge.
- Auto-Draft resets to off whenever the app reloads or switches leagues.
- The content script refuses snake selections when ESPN does not show the user on the clock.
- Every write verifies the expected ESPN league; auction bids also verify the visible nominee.
- If ESPN changes its draft-room markup, the action fails closed and reports an error instead of clicking an unknown control.

ESPN's fantasy API and draft-room markup are undocumented and can change without notice. Validate the companion against an ESPN mock draft before relying on it in a live league.
