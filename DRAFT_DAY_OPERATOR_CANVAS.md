# DraftForge day-one draft canvas

> **Your job:** open the right league, verify the checklist, and decide when to arm.
>
> **DraftForge's job:** continuously read ESPN, make the best legal five-source decision, and execute it inside the exact safety window.
>
> **If anything is uncertain:** DraftForge stops. It does not guess, chase a bid, or click twice.

This is the practical guide for using DraftForge in a real ESPN snake or salary-cap draft. Read it once before draft day, then use the checkboxes during the event. For release evidence, exact commands, and recovery internals, see [DRAFT_DAY_HANDOVER.md](DRAFT_DAY_HANDOVER.md).

## The 60-second explanation

DraftForge has three visible surfaces, but only one production writer:

| Surface | What it is for | What you do there |
| --- | --- | --- |
| **DraftForge dashboard** | Command center and sole control surface | Import, verify, arm, hold, resume, and inspect the current decision |
| **ESPN draft room** | Authoritative draft state | Watch the room; keep ESPN Autopick off |
| **Codex chat** | Strategy and status cockpit | Ask what is happening, why a player is preferred, and whether strategy should change |

The DraftForge Chrome companion executes actions. Chat is intentionally read-only: asking questions cannot slow, replace, or duplicate a live ESPN action.

## Do not confuse these two switches

| Switch | Required state | Meaning |
| --- | --- | --- |
| **ESPN Autopick** | **OFF** | ESPN's generic fallback drafter. DraftForge will not act while it is on or unknown. |
| **DraftForge Auto-Draft** | **OFF until both READY gates pass** | The explicitly armed DraftForge writer for the one verified room. |

DraftForge Auto-Draft is not ESPN Autopick. It is a scoped execution mode with exact league, team, tab, clock, player, roster, source, and budget checks. It resets to **OFF** on reload, league switch, recovery, safety failure, completion, or a dashboard hold.

## Day-one flow

```text
Prepare machine
      ↓
Open exactly DraftForge + the ESPN league
      ↓
Import and verify authenticated rules
      ↓
Refresh five sources and availability vetoes
      ↓
PRE-ROOM READY — Auto-Draft remains OFF
      ↓
Click Confirm + arm live draft (stores one exact room-watch intent)
      ↓
Enter the exact ESPN draft room
      ↓
DraftForge binds, reruns LIVE READY, and arms only if every check passes
      ↓
DraftForge executes; chat monitors and explains
      ↓
Final ESPN parity audit → automatic shutdown
```

## T-24 hours: prepare once

- [ ] Mac is on power and sleep is disabled for the draft window.
- [ ] Network is stable and a backup connection is available.
- [ ] Chrome is signed into the correct ESPN account.
- [ ] The current DraftForge release is committed, pushed, and passing CI.
- [ ] The DraftForge companion is installed from this repository's `extension/` directory.
- [ ] One no-click rehearsal has passed for the same league and format.
- [ ] The current release is marked **GO** in [DRAFT_DAY_HANDOVER.md](DRAFT_DAY_HANDOVER.md). Historical test results are not enough.

Do not update code, rebuild, reinstall extensions, or change firewall settings during a live room.

## T-60 minutes: cold start

1. Quit Chrome completely.
2. Start DraftForge production from `/Users/chris/github/draftforge-ai`:

   ```bash
   npm start
   ```

3. Open exactly two Chrome tabs:

   - `http://127.0.0.1:3000`
   - the exact authenticated ESPN league page

4. Keep DraftForge and ESPN visible in separate Chrome windows. Close practice rooms, duplicate dashboards, extension pages, blank tabs, and unrelated tabs.
5. In Codex, say:

   > Draft day. Use the exact named ESPN league and team. Run the complete cold-start checklist. Keep DraftForge Auto-Draft off and do not enter or arm the room until you report READY.

## Gate 1: before entering the room

In the DraftForge dashboard:

- [ ] Click **Re-import from ESPN**.
- [ ] Verify the exact league and signed-in team.
- [ ] Verify snake or salary-cap format.
- [ ] Verify scoring, team count, roster slots, position caps, keepers, timer, and budget.
- [ ] Verify the authenticated ESPN player pool is complete.
- [ ] Verify all five fixed sources are fresh: ESPN, FFC, MFL, Tradyr, and GNG.
- [ ] Verify current availability news has been scanned and is shown as a separate hold/veto layer—not a sixth ranking source.
- [ ] Verify the selected strategy.
- [ ] Verify **ESPN Autopick OFF**.
- [ ] Verify **DraftForge Auto-Draft OFF**.
- [ ] Require `DRAFT_DAY_READY` with no blockers.
- [ ] Click **Confirm + arm live draft** once. This does not grant immediate ESPN action authority; it stores a short-lived, one-shot intent for the exact source league, team, season, and format.

If any line is missing, stale, or ambiguous, stop here. Do not enter the room hoping it will repair itself.

## Gate 2: inside the exact room

Once ESPN opens the real room:

- [ ] Confirm DraftForge bound the exact room, league, team, season, and tab.
- [ ] Confirm ESPN's clock, player pool, roster, and action controls are readable.
- [ ] Confirm ESPN Autopick is still off.
- [ ] Confirm five-source freshness has not expired.
- [ ] Confirm DraftForge shows one legal recommendation without clicking it.
- [ ] For salary cap, confirm the nominee, current offer, next legal offer, maximum bid, reserve, and nomination intent.
- [ ] Require the live READY result.

The companion may fulfill the pre-room one-shot intent only after every live item passes in the exact room. If the room was already open, the watch expired, or recovery reset the state, click **Confirm live-room checklist**, switch **Auto-Draft** on, and approve the **Enable Auto-Draft** confirmation only after the complete live checklist passes. Any mismatch leaves Auto-Draft off.

## What Auto-Draft does in a snake draft

When your verified clock opens, DraftForge:

1. Removes drafted, unavailable, illegal, duplicate, and position-capped players.
2. Scores the remaining pool using the deterministic five-source consensus, projections, VORP, positional scarcity, roster construction, ADP value, source confidence, and sleeper timing.
3. Publishes the recommended player and alternatives before the action.
4. Waits for a deterministic, varied late-clock point while preserving the full safety and confirmation budget.
5. Rechecks the exact pick, player, roster, source snapshot, availability evidence, clock, ESPN Autopick state, and action control.
6. Selects once and requires ESPN roster confirmation.

It does **not** blindly pick the top ADP player, draft a second unnecessary K/DST, retry an uncertain click, or act from an opponent's clock.

## What Auto-Draft does in a salary-cap draft

For every nomination and offer, DraftForge continuously evaluates:

- five-source auction value and scoring-adjusted fair value;
- current bid versus the exact source-backed ceiling;
- budget remaining and the mandatory `$1 × open roster slots` reserve;
- position budgets, starter needs, scarcity, and roster-completion feasibility;
- room inflation, opponent spending, remaining leverage, and spend velocity;
- whether we already lead the player;
- sleeper value and the correct time to expose or protect the target; and
- target nominations versus safe drain nominations.

The bidding rules are strict:

- Bid only the next legal amount—normally `$1`.
- Never raise our own leading bid.
- Never cross the exact DraftForge ceiling or ESPN reserve maximum.
- Never turn a scarcity signal into a bidding war.
- Preserve enough money and legal inventory to complete every mandatory slot.
- Treat a clicked-but-unconfirmed bid or nomination as uncertain and stop until ESPN reconciles it.

## What you watch during the draft

The dashboard should answer six questions at a glance:

1. **Are we armed?**
2. **Is ESPN Autopick off?**
3. **What action is next?**
4. **How much time is safely available?**
5. **Why is this player or bid preferred?**
6. **What would make DraftForge stop?**

For salary cap, also watch remaining budget, protected reserve, maximum bid, room inflation, roster needs, and whether the current nomination is **TARGET** or **DRAIN**.

Useful chat requests:

- `status` — current action, clock, roster need, budget, and safety state.
- `explain` — why the current recommendation wins.
- `alternatives` — the best legal fallback choices.
- `strategy check` — whether opponent behavior supports a change between action windows.
- `top three teams` — current opponent-roster assessment from the sanitized league board.

Chat requests are advisory. Use the DraftForge dashboard for arm, hold, resume, and Guided approvals.

## If something looks wrong

### Safest universal response

1. Click **Hold** in DraftForge.
2. Do not repeatedly click ESPN.
3. Tell Codex: `status — explain the blocker`.
4. Resume only after the dashboard reruns every live safety check.

### Specific incidents

| Incident | What happens | What you do |
| --- | --- | --- |
| ESPN Autopick turns on | DraftForge disarms and blocks actions | Turn ESPN Autopick off, verify the roster, rerun READY, then re-arm |
| Source or news evidence becomes stale | DraftForge blocks recommendations/actions | Refresh outside an action window and rerun READY |
| Dashboard reloads or server restarts | Auto-Draft resets off; old authority expires | Re-import, verify parity, rerun READY, and re-arm |
| Pick/bid may have clicked but is unconfirmed | DraftForge fences new actions | Wait for exact ESPN reconciliation; never click again blindly |
| Wrong or duplicate room/tab appears | DraftForge fails closed | Hold, return to one dashboard and one exact ESPN room, then recover |
| Clock is short, unknown, changed, or belongs to an opponent | DraftForge does not act | Let ESPN state settle; do not override the guard |

Never begin an optional recovery during your snake clock or an active salary-cap offer. Never make code changes during the draft.

## When to use Guided mode

Use Guided mode when you want to approve every action and the room provides enough time. The dashboard shows the recommendation and waits for your approval.

Use armed Auto-Draft when:

- both READY gates passed;
- the exact room is stable;
- rapid bidding or short clocks make manual approval risky; and
- you want DraftForge to execute its already-inspected strategy without waiting for chat.

Auto-Draft is designed to be unattended **after** explicit arming, not ungoverned. Every action still requires fresh evidence and an exact, expiring authorization.

## End of draft

- [ ] DraftForge and ESPN rosters match exactly.
- [ ] Salary-cap prices and remaining budget match exactly.
- [ ] Every mandatory starter can be filled.
- [ ] K and DST requirements are satisfied without unnecessary duplicates.
- [ ] There are no duplicate players, position-cap violations, reserve violations, or unattributed actions.
- [ ] The final audit returns READY.
- [ ] DraftForge Auto-Draft shuts off automatically.
- [ ] The completed practice room and managed DraftForge tabs are cleaned up.

Do not use DraftForge for waivers, trades, lineup management, or other post-draft league operations. Those features are intentionally out of scope.

## The one rule to remember

> **Two READY gates, ESPN Autopick off, then arm DraftForge once. If the state becomes ambiguous, hold and revalidate—never improvise inside the clock.**
