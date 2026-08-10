"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  describeRecommendation,
  recommendPlayers,
  type DraftPick,
  type DraftPlayer,
  type LeagueSettings,
  type Position,
  type StrategyId,
} from "./lib/draft-engine";
import { mergeConsensus, type IntelligenceSource } from "./lib/consensus";
import { profileForEspnRoom, upsertDraftProfile, type DraftProfile } from "./lib/profiles";

const DEMO_PLAYERS: DraftPlayer[] = [
  { id: 1, name: "Ja'Marr Chase", team: "CIN", pos: "WR", rank: 1, adp: 1.4, auction: 61, projected: 312 },
  { id: 2, name: "Bijan Robinson", team: "ATL", pos: "RB", rank: 2, adp: 2.1, auction: 59, projected: 298 },
  { id: 3, name: "Jahmyr Gibbs", team: "DET", pos: "RB", rank: 3, adp: 3.2, auction: 57, projected: 291 },
  { id: 4, name: "Justin Jefferson", team: "MIN", pos: "WR", rank: 4, adp: 4.6, auction: 56, projected: 300 },
  { id: 5, name: "CeeDee Lamb", team: "DAL", pos: "WR", rank: 5, adp: 5.1, auction: 54, projected: 294 },
  { id: 6, name: "Puka Nacua", team: "LAR", pos: "WR", rank: 6, adp: 6.8, auction: 51, projected: 286 },
  { id: 7, name: "Saquon Barkley", team: "PHI", pos: "RB", rank: 7, adp: 7.5, auction: 49, projected: 276 },
  { id: 8, name: "Malik Nabers", team: "NYG", pos: "WR", rank: 8, adp: 9.7, auction: 47, projected: 278 },
  { id: 9, name: "Amon-Ra St. Brown", team: "DET", pos: "WR", rank: 9, adp: 8.4, auction: 46, projected: 281 },
  { id: 10, name: "De'Von Achane", team: "MIA", pos: "RB", rank: 10, adp: 11.8, auction: 44, projected: 265 },
  { id: 11, name: "Brock Bowers", team: "LV", pos: "TE", rank: 11, adp: 13.5, auction: 39, projected: 244 },
  { id: 12, name: "Nico Collins", team: "HOU", pos: "WR", rank: 12, adp: 14.9, auction: 38, projected: 260 },
  { id: 13, name: "Josh Allen", team: "BUF", pos: "QB", rank: 13, adp: 20.3, auction: 36, projected: 388 },
  { id: 14, name: "Brian Thomas Jr.", team: "JAX", pos: "WR", rank: 14, adp: 17.1, auction: 35, projected: 252 },
  { id: 15, name: "Jonathan Taylor", team: "IND", pos: "RB", rank: 15, adp: 15.8, auction: 34, projected: 251 },
  { id: 16, name: "Lamar Jackson", team: "BAL", pos: "QB", rank: 16, adp: 23.8, auction: 31, projected: 374 },
  { id: 17, name: "Trey McBride", team: "ARI", pos: "TE", rank: 17, adp: 22.4, auction: 29, projected: 221 },
  { id: 18, name: "Drake London", team: "ATL", pos: "WR", rank: 18, adp: 19.2, auction: 29, projected: 247 },
  { id: 19, name: "Bucky Irving", team: "TB", pos: "RB", rank: 19, adp: 24.7, auction: 27, projected: 238 },
  { id: 20, name: "Jayden Daniels", team: "WAS", pos: "QB", rank: 20, adp: 27.3, auction: 25, projected: 356 },
];

const DEMO_LEAGUE: LeagueSettings = {
  id: "demo", name: "ESPN League Preview", season: 2026, size: 12, teamId: 4, draftType: "SNAKE",
  secondsPerPick: 90, rosterSize: 16, auctionBudget: 200, lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  positionLimits: {}, scoringLabel: "PPR", scoringRules: 19, keeperCount: 0, pickOrder: [], teams: [],
};

const FILTERS = ["ALL", "QB", "RB", "WR", "TE", "DST", "K"] as const;
const STRATEGIES: { id: StrategyId; label: string; description: string }[] = [
  { id: "BALANCED", label: "Balanced value", description: "Take the strongest value while filling starters naturally." },
  { id: "HERO_RB", label: "Hero RB", description: "Secure one premium RB, then lean into receivers and value." },
  { id: "ZERO_RB", label: "Zero RB", description: "Prioritize elite receivers and onesie positions early." },
  { id: "ELITE_QB", label: "Elite QB", description: "Raise the value of top dual-threat quarterbacks." },
];

type ExtensionStatus = "checking" | "missing" | "ready" | "connecting" | "connected" | "error";
type EspnContext = { onClock?: boolean; inDraftRoom?: boolean; auctionActive?: boolean; leagueId?: string; teamId?: number; nominatedPlayer?: string; currentBid?: number; leadingBid?: boolean };

function sendToExtension(type: string, payload: Record<string, unknown> = {}) {
  window.postMessage({ source: "draftforge-web", type, payload }, window.location.origin);
}

function rosterSlots(league: LeagueSettings) {
  const labels: Record<string, string> = { "0": "QB", "2": "RB", "4": "WR", "6": "TE", "16": "DST", "17": "K", "20": "BN", "21": "IR", "23": "FLEX" };
  return Object.entries(league.lineupSlotCounts || {}).flatMap(([slot, count]) => Array.from({ length: Number(count) }, () => labels[slot] || `S${slot}`));
}

export default function Home() {
  const [extension, setExtension] = useState<ExtensionStatus>("checking");
  const [context, setContext] = useState<EspnContext>({});
  const [league, setLeague] = useState<LeagueSettings>(DEMO_LEAGUE);
  const [espnPlayers, setEspnPlayers] = useState<DraftPlayer[]>(DEMO_PLAYERS);
  const [sources, setSources] = useState<IntelligenceSource[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [intelligenceLoading, setIntelligenceLoading] = useState(true);
  const [picks, setPicks] = useState<DraftPick[]>([]);
  const [settingsConfirmed, setSettingsConfirmed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [rawSettingsOpen, setRawSettingsOpen] = useState(false);
  const [leagueId, setLeagueId] = useState("");
  const [strategy, setStrategy] = useState<StrategyId>("BALANCED");
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [autoDraft, setAutoDraft] = useState(false);
  const [autoWarning, setAutoWarning] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(1);
  const [actionState, setActionState] = useState("Waiting for ESPN connection.");
  const [profiles, setProfiles] = useState<Record<string, DraftProfile>>({});
  const lastAutoAction = useRef("");
  const profilesRef = useRef<Record<string, DraftProfile>>({});
  const activeLeagueRef = useRef("demo");

  function activateProfile(profile: DraftProfile, roomContext?: EspnContext) {
    activeLeagueRef.current = profile.league.id;
    setLeague(profile.league);
    setEspnPlayers(profile.espnPlayers);
    setPicks(profile.picks);
    setSettingsConfirmed(profile.settingsConfirmed);
    setStrategy(profile.strategy);
    setLeagueId(profile.league.id);
    setAutoDraft(false);
    setContext((current) => ({ ...current, ...(roomContext || {}) }));
    setExtension("connected");
    setSettingsOpen(!profile.settingsConfirmed);
    setActionState(`${profile.league.name} loaded. Auto-Draft is off.`);
  }

  function startAnotherLeague() {
    activeLeagueRef.current = "demo";
    setLeague(DEMO_LEAGUE);
    setEspnPlayers(DEMO_PLAYERS);
    setPicks([]);
    setLeagueId("");
    setSettingsConfirmed(false);
    setAutoDraft(false);
    setExtension("ready");
    setSettingsOpen(true);
    setActionState("Open the other ESPN league, then import it.");
  }

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("draftforge-leagues-v1") || "{}");
      profilesRef.current = saved;
      setProfiles(saved);
    } catch { /* ignore an invalid local draft cache */ }
    const timeout = window.setTimeout(() => setExtension((status) => status === "checking" ? "missing" : status), 1200);
    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== "draftforge-extension") return;
      const { type, payload } = event.data;
      if (type === "EXTENSION_READY") {
        setExtension("ready");
        setContext(payload?.context || {});
        const profile = profileForEspnRoom(profilesRef.current, payload?.context?.leagueId);
        if (profile) activateProfile(profile, payload.context);
      }
      if (type === "DF_ESPN_CONTEXT") {
        setContext(payload || {});
        const profile = payload?.inDraftRoom ? profileForEspnRoom(profilesRef.current, payload?.leagueId) : undefined;
        if (profile && profile.league.id !== activeLeagueRef.current) activateProfile(profile, payload);
      }
      if (type === "DF_IMPORT_SUCCESS" || (type === "COMMAND_RESULT" && payload?.data?.league)) {
        const data = type === "DF_IMPORT_SUCCESS" ? payload : payload.data;
        setLeague(data.league);
        setEspnPlayers(data.players?.length ? data.players : DEMO_PLAYERS);
        setPicks(data.picks || []);
        setContext(data.context || {});
        setLeagueId(String(data.league.id));
        setExtension("connected");
        setSettingsOpen(true);
        setSettingsConfirmed(false);
        setActionState("ESPN settings imported. Confirm them before drafting.");
        const profile: DraftProfile = { league: data.league, espnPlayers: data.players?.length ? data.players : DEMO_PLAYERS, picks: data.picks || [], settingsConfirmed: false, strategy: "BALANCED", savedAt: new Date().toISOString() };
        profilesRef.current = upsertDraftProfile(profilesRef.current, profile);
        setProfiles(profilesRef.current);
      }
      if (type === "DF_DRAFT_UPDATE") {
        setPicks(payload.picks || []);
        setContext((current) => ({ ...current, ...(payload.context || {}) }));
      }
      if (type === "DF_ACTION_RESULT") {
        setActionState(payload.ok ? payload.message : `Action stopped: ${payload.message}`);
      }
      if (type === "DF_EXTENSION_ERROR" || type === "EXTENSION_ERROR") {
        setExtension("error");
        setActionState(payload.message || "The ESPN companion reported an error.");
      }
      if (type === "COMMAND_RESULT" && payload?.ok === false) {
        setExtension(payload.code === "NO_LEAGUE" ? "ready" : "error");
        setActionState(payload.message || "Could not connect to ESPN.");
      }
    }
    window.addEventListener("message", onMessage);
    return () => { window.clearTimeout(timeout); window.removeEventListener("message", onMessage); };
  }, []);

  useEffect(() => {
    profilesRef.current = profiles;
    window.localStorage.setItem("draftforge-leagues-v1", JSON.stringify(profiles));
  }, [profiles]);

  useEffect(() => {
    if (league.id === "demo" || extension !== "connected") return;
    activeLeagueRef.current = league.id;
    setProfiles((current) => upsertDraftProfile(current, { league, espnPlayers, picks, settingsConfirmed, strategy, savedAt: new Date().toISOString() }));
  }, [league, espnPlayers, picks, settingsConfirmed, strategy, extension]);

  useEffect(() => {
    const controller = new AbortController();
    setIntelligenceLoading(true);
    fetch(`/api/intelligence?scoring=${encodeURIComponent(league.scoringLabel)}&teams=${league.size}&season=${league.season}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => setSources(data.sources || []))
      .catch(() => setSources([]))
      .finally(() => setIntelligenceLoading(false));
    return () => controller.abort();
  }, [league.scoringLabel, league.size, league.season]);

  const players = useMemo(() => mergeConsensus(espnPlayers, sources), [espnPlayers, sources]);

  const recommendations = useMemo(() => recommendPlayers(players, picks, league, strategy), [players, picks, league, strategy]);
  const selected = recommendations.find((player) => player.id === selectedId) || recommendations[0];
  const nominated = context.nominatedPlayer ? recommendations.find((player) => context.nominatedPlayer?.toLowerCase().includes(player.name.toLowerCase())) : undefined;
  const focusPlayer = league.draftType === "AUCTION" && nominated ? nominated : selected;
  const nextBid = focusPlayer ? Math.min(focusPlayer.maxBid, Math.max(1, Number(context.currentBid || 0) + 1)) : 1;
  const draftedIds = useMemo(() => new Set(picks.map((pick) => pick.playerId)), [picks]);
  const visible = recommendations.filter((player) =>
    (filter === "ALL" || player.pos === filter) && `${player.name} ${player.team}`.toLowerCase().includes(query.toLowerCase())
  );
  const myPicks = picks.filter((pick) => pick.teamId === league.teamId);
  const myRoster = myPicks.map((pick) => ({ pick, player: players.find((player) => player.id === pick.playerId) })).filter((item) => item.player) as { pick: DraftPick; player: DraftPlayer }[];
  const currentPick = picks.length + 1;
  const currentRound = league.draftType === "SNAKE" ? Math.floor(picks.length / league.size) + 1 : null;
  const spent = myPicks.reduce((sum, pick) => sum + pick.amount, 0);
  const strategyInfo = STRATEGIES.find((item) => item.id === strategy) || STRATEGIES[0];

  function connect() {
    setExtension("connecting");
    setActionState("Reading your signed-in ESPN league…");
    sendToExtension("CONNECT_ESPN", { leagueId: leagueId.trim() || undefined, season: 2026 });
  }

  function submit(player = focusPlayer, automatic = false, operation?: "SELECT" | "NOMINATE" | "BID", amount?: number) {
    if (!player || !settingsConfirmed || extension !== "connected") {
      setActionState("Connect ESPN and confirm the imported rules first.");
      return;
    }
    const resolvedOperation = operation || (league.draftType === "AUCTION" ? "NOMINATE" : "SELECT");
    setActionState(`${automatic ? "Auto-Draft is submitting" : "Submitting"} ${player.name} in ESPN…`);
    sendToExtension("SUBMIT_ACTION", {
      operation: resolvedOperation,
      playerId: player.id,
      playerName: player.name,
      amount: resolvedOperation === "BID" ? amount ?? player.maxBid : undefined,
      requireOnClock: resolvedOperation !== "BID",
      expectedLeagueId: league.id,
      expectedPick: currentPick,
    });
  }

  useEffect(() => {
    if (!autoDraft || !settingsConfirmed || extension !== "connected" || !context.onClock || !recommendations[0]) return;
    const key = `${league.id}:${currentPick}:${recommendations[0].id}:${league.draftType}`;
    if (lastAutoAction.current === key) return;
    lastAutoAction.current = key;
    submit(recommendations[0], true, league.draftType === "AUCTION" ? "NOMINATE" : "SELECT");
  }, [autoDraft, settingsConfirmed, extension, context.onClock, recommendations, league.id, league.draftType, currentPick]);

  useEffect(() => {
    if (!autoDraft || !settingsConfirmed || extension !== "connected" || league.draftType !== "AUCTION" || !nominated || context.leadingBid) return;
    const bid = Math.max(1, Number(context.currentBid || 0) + 1);
    if (bid > nominated.maxBid) return;
    const key = `${league.id}:bid:${nominated.id}:${bid}`;
    if (lastAutoAction.current === key) return;
    lastAutoAction.current = key;
    submit(nominated, true, "BID", bid);
  }, [autoDraft, settingsConfirmed, extension, league.draftType, league.id, nominated, context.currentBid, context.leadingBid]);

  function enableAutoDraft() {
    if (autoDraft) { setAutoDraft(false); return; }
    setAutoWarning(true);
  }

  const slots = rosterSlots(league);
  const assigned = new Set<number>();
  const rosterRows = slots.map((slot) => {
    const item = myRoster.find(({ player }) => !assigned.has(player.id) && (slot === "FLEX" ? ["RB", "WR", "TE"].includes(player.pos) : slot === "BN" || player.pos === slot));
    if (item) assigned.add(item.player.id);
    return { slot, item };
  });

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">DF</span><span>DraftForge <b>AI</b></span></div>
      <div className={`draft-status ${context.onClock ? "on-clock" : ""}`}><span className="live-dot" />{context.onClock ? "YOU'RE ON THE CLOCK" : extension === "connected" ? "ESPN LIVE" : "DRAFT CONTROL ROOM"}<strong>{league.draftType === "SNAKE" ? `Round ${currentRound} · Pick ${currentPick}` : `$${league.auctionBudget - spent} remaining`}</strong></div>
      <div className="header-actions">
        <button className={`auto-toggle ${autoDraft ? "enabled" : ""}`} onClick={enableAutoDraft} disabled={!settingsConfirmed || extension !== "connected"}><i />Auto-Draft {autoDraft ? "ON" : "OFF"}</button>
        <button className="settings-button" onClick={() => setSettingsOpen(true)}>League rules</button>
      </div>
    </header>

    <section className="context-strip">
      <div><span className="platform-chip">E</span><div><select className="league-switcher" value={league.id} onChange={(event) => { if (event.target.value === "__new") startAnotherLeague(); else { const profile = profiles[event.target.value]; if (profile) activateProfile(profile); } }}><option value="demo">{league.id === "demo" ? league.name : "Choose draft"}</option>{Object.values(profiles).sort((a, b) => a.league.name.localeCompare(b.league.name)).map((profile) => <option key={profile.league.id} value={profile.league.id}>{profile.league.name}</option>)}<option value="__new">＋ Import another ESPN league</option></select><small>ESPN · {league.size}-team · {league.scoringLabel} · {league.draftType === "AUCTION" ? `$${league.auctionBudget} salary cap` : "Snake"}</small></div></div>
      <div className="progress-wrap"><span>Draft progress</span><div className="progress"><i style={{ width: `${Math.min(100, picks.length / Math.max(1, league.size * league.rosterSize) * 100)}%` }} /></div><b>{picks.length}/{league.size * league.rosterSize}</b></div>
      <div className={`sync-note ${extension === "connected" ? "connected" : ""}`}><span>●</span>{extension === "connected" ? `Synced · League ${league.id}` : extension === "missing" ? "Companion not detected" : extension === "connecting" ? "Connecting to ESPN…" : "ESPN companion ready"}</div>
    </section>

    {(extension !== "connected" || settingsOpen) && <section className="setup-drawer">
      {extension !== "connected" ? <div className="connect-card">
        <div><p className="eyebrow">STEP 1 · ESPN CONNECTION</p><h1>Import your real draft.</h1><p>Open your ESPN league in another Chrome tab. The companion reads your authenticated settings without exposing your password or cookies.</p></div>
        <label>League ID <input value={leagueId} onChange={(event) => setLeagueId(event.target.value.replace(/\D/g, ""))} placeholder="Auto-detect or enter ID" inputMode="numeric" /></label>
        <button className="primary-button" onClick={connect} disabled={extension === "missing" || extension === "connecting"}>{extension === "connecting" ? "Importing…" : "Import from ESPN"}</button>
        {extension === "missing" && <p className="connect-error">Download and unzip the Chrome companion, load that folder at chrome://extensions, then refresh this page.</p>}
        <a className="extension-download" href="/draftforge-espn-companion.zip" download>Download Chrome companion ↓</a>
        <button className="preview-link" onClick={() => { setSettingsOpen(true); setExtension("ready"); }}>Explore with preview data</button>
      </div> : <div className="rules-card">
        <div className="rules-heading"><div><p className="eyebrow">STEP 2 · VERIFY IMPORT</p><h2>Confirm ESPN league rules</h2><p>Draft actions stay locked until these imported settings match your ESPN league.</p></div><button onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button></div>
        <div className="rule-grid">
          <div><span>Draft</span><b>{league.draftType === "AUCTION" ? "Salary cap" : "Snake"}</b><small>{league.secondsPerPick}s timer{league.keeperCount ? ` · ${league.keeperCount} keepers` : " · no keepers"}</small></div>
          <div><span>League</span><b>{league.size} teams</b><small>{league.rosterSize} roster spots</small></div>
          <div><span>Scoring</span><b>{league.scoringLabel}</b><small>{league.scoringRules} imported scoring rules</small></div>
          <div><span>{league.draftType === "AUCTION" ? "Budget" : "Draft order"}</span><b>{league.draftType === "AUCTION" ? `$${league.auctionBudget}` : league.pickOrder.length ? `${league.pickOrder.length} slots imported` : "Set by ESPN"}</b><small>{league.draftType === "AUCTION" ? "$1 minimum per open slot" : "Live order follows ESPN"}</small></div>
        </div>
        <div className="slot-summary"><span>Roster:</span>{Object.entries(league.lineupSlotCounts).map(([slot, count]) => <b key={slot}>{rosterSlots({ ...league, lineupSlotCounts: { [slot]: count } })[0] || `Slot ${slot}`} × {count}</b>)}</div>
        <button className="raw-toggle" onClick={() => setRawSettingsOpen((value) => !value)}>{rawSettingsOpen ? "Hide" : "Inspect"} all imported ESPN fields</button>
        {rawSettingsOpen && <pre className="raw-settings">{JSON.stringify(league.rawSettings || league, null, 2)}</pre>}
        <div className="rule-actions"><button className="secondary-button" onClick={connect}>Re-import</button><button className="primary-button" onClick={() => { setSettingsConfirmed(true); setSettingsOpen(false); setActionState("Rules confirmed. Draft actions are unlocked."); }}>I confirm these rules</button></div>
      </div>}
    </section>}

    <section className="strategy-bar">
      <div><span>Draft strategy</span><button onClick={() => setStrategyOpen((open) => !open)}>{strategyInfo.label}⌄</button><small>{strategyInfo.description}</small></div>
      <button className="engine-badge" onClick={() => setSourcesOpen((open) => !open)}><i>◆</i><span><b>{intelligenceLoading ? "Refreshing intelligence…" : `${1 + sources.filter((source) => source.status === "ok").length}/5 sources live`}</b><small>Weighted consensus · inspect sources</small></span></button>
      <div className={`action-feed ${actionState.includes("stopped") ? "error" : ""}`}><span>STATUS</span>{actionState}</div>
      {strategyOpen && <div className="strategy-menu">{STRATEGIES.map((item) => <button key={item.id} className={strategy === item.id ? "active" : ""} onClick={() => { setStrategy(item.id); setStrategyOpen(false); }}><b>{item.label}</b><small>{item.description}</small></button>)}</div>}
      {sourcesOpen && <div className="sources-menu"><div><b>Decision intelligence</b><button onClick={() => setSourcesOpen(false)}>×</button></div><p>ESPN anchors league-specific projections at 30%. Four independent public feeds supply model rankings and real draft-market prices.</p><ul><li><span className="source-ok">●</span><b>ESPN Fantasy</b><small>30% · league projection, ADP, auction value</small></li>{sources.map((source) => <li key={source.id}><span className={source.status === "ok" ? "source-ok" : "source-error"}>●</span><b>{source.name}</b><small>{Math.round(source.weight * 100)}% · {source.kind}{source.sampleSize ? ` · ${source.sampleSize.toLocaleString()} drafts` : ""} · <a href={source.url} target="_blank" rel="noreferrer">source</a></small></li>)}</ul><small>Sources that fail or become stale are removed and remaining weights are renormalized.</small></div>}
    </section>

    <section className="workspace">
      <section className="players-panel panel">
        <div className="panel-head"><div><p className="eyebrow">LIVE ESPN PLAYER POOL</p><h1>{league.draftType === "AUCTION" ? "Find the next value." : "Make the next pick."}</h1></div><label className="search-box">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player or team" /></label></div>
        <div className="filters">{FILTERS.map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div>
        <div className="table-head"><span>#</span><span>PLAYER</span><span>POS</span><span>{league.draftType === "AUCTION" ? "ESPN $" : "ADP"}</span><span>PROJ</span><span>MODEL</span></div>
        <div className="player-list">{visible.slice(0, 150).map((player, index) => <button key={player.id} className={`player-row ${selected?.id === player.id ? "selected" : ""}`} onClick={() => setSelectedId(player.id)}>
          <span className="rank">{index + 1}</span><span className="player-name"><span><b>{player.name}</b><small>{player.team}{player.injured ? " · Injury flag" : ""}</small></span></span><i className={`pos ${player.pos.toLowerCase()}`}>{player.pos}</i><span>{league.draftType === "AUCTION" ? `$${player.auction}` : player.adp < 900 ? player.adp.toFixed(1) : "—"}</span><span>{player.projected ? player.projected.toFixed(1) : "—"}</span><span className="model-score">{Math.round(player.score)}</span>
          {index === 0 && <em className="best-badge">BEST FIT</em>}
        </button>)}</div>
      </section>

      <aside className="coach-column">
        {focusPlayer && <section className="recommendation panel">
          <div className="rec-label"><span>◆</span> RECOMMENDATION · {league.draftType}</div>
          {nominated && <p className="auction-live">LIVE NOMINATION · {context.currentBid ? `$${context.currentBid}` : "Opening bid"}</p>}
          <div className="rec-player"><div className={`avatar ${focusPlayer.pos.toLowerCase()}`}>{focusPlayer.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</div><div><h2>{focusPlayer.name}</h2><p>{focusPlayer.pos} · {focusPlayer.team} <span>Consensus #{focusPlayer.consensusRank || "—"}</span></p></div></div>
          <div className="confidence"><div><span>Decision confidence · {focusPlayer.sourceCount || 1}/5 sources</span><b>{focusPlayer.confidence}%</b></div><div className="confidence-track"><i style={{ width: `${focusPlayer.confidence}%` }} /></div></div>
          <p className="reason">{describeRecommendation(focusPlayer, league, strategy)}</p>
          <div className="rec-stats"><div><span>VORP</span><b>+{focusPlayer.vorp.toFixed(1)}</b></div><div><span>TIER DROP</span><b>{focusPlayer.scarcity.toFixed(1)}</b></div><div><span>{league.draftType === "AUCTION" ? "MAX BID" : "ADP EDGE"}</span><b>{league.draftType === "AUCTION" ? `$${focusPlayer.maxBid}` : `${focusPlayer.adpValue >= 0 ? "+" : ""}${focusPlayer.adpValue.toFixed(1)}`}</b></div></div>
          <ul className="reason-list">{focusPlayer.reasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}</ul>
          {league.draftType === "SNAKE" ? <button className="draft-button full" onClick={() => submit(focusPlayer, false, "SELECT")} disabled={!settingsConfirmed || extension !== "connected"}>Select & submit pick in ESPN</button> : <div className="pick-actions"><button className="draft-button" onClick={() => submit(focusPlayer, false, "NOMINATE")} disabled={!settingsConfirmed || extension !== "connected" || Boolean(nominated)}>Nominate in ESPN</button><button className="bid-button" onClick={() => submit(focusPlayer, false, "BID", nextBid)} disabled={!settingsConfirmed || extension !== "connected" || !nominated || context.leadingBid || nextBid > focusPlayer.maxBid}>Bid ${nextBid}<small>max ${focusPlayer.maxBid}</small></button></div>}
          {!settingsConfirmed && <small className="locked-note">Confirm imported league rules to unlock ESPN actions.</small>}
        </section>}
        <section className="on-clock-card panel"><span className={context.onClock ? "pulse" : ""}>●</span><div><b>{context.onClock ? "Your ESPN action is ready" : context.inDraftRoom ? "Draft room connected" : "Open the ESPN draft room"}</b><small>{autoDraft ? "Auto-Draft will submit the top legal recommendation." : "You approve every pick, nomination, and bid here."}</small></div></section>
      </aside>

      <aside className="roster-panel panel">
        <div className="roster-head"><div><p className="eyebrow">MY ESPN TEAM</p><h2>Roster & budget</h2></div><span>{myRoster.length}/{league.rosterSize}</span></div>
        {league.draftType === "AUCTION" && <div className="budget-card"><div><span>Remaining</span><b>${league.auctionBudget - spent}</b></div><div><span>Max single bid</span><b>${Math.max(1, league.auctionBudget - spent - Math.max(0, league.rosterSize - myRoster.length - 1))}</b></div></div>}
        <div className="roster-list">{rosterRows.map(({ slot, item }, index) => <div className={`roster-row ${item ? "filled" : ""}`} key={`${slot}-${index}`}><span>{slot}</span>{item ? <><div><b>{item.player.name}</b><small>{item.player.team}{item.pick.amount ? ` · $${item.pick.amount}` : ""}</small></div><i className={`pos ${item.player.pos.toLowerCase()}`}>{item.player.pos}</i></> : <em>Open</em>}</div>)}</div>
        <div className="draft-log"><p>RECENT ESPN ACTIVITY</p>{picks.slice(-5).reverse().map((pick) => { const player = players.find((item) => item.id === pick.playerId); return <div key={`${pick.overall}-${pick.playerId}`}><span>{pick.overall}</span><b>{player?.name || `Player ${pick.playerId}`}</b><small>{pick.amount ? `$${pick.amount}` : `Team ${pick.teamId}`}</small></div>; })}{!picks.length && <small>No picks imported yet.</small>}</div>
      </aside>
    </section>

    {autoWarning && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Enable Auto-Draft"><div className="warning-modal"><span className="warning-icon">!</span><h2>Let DraftForge submit picks?</h2><p>When ESPN shows you on the clock, DraftForge will immediately submit the top legal recommendation using the confirmed rules and selected strategy.</p><ul><li>Snake picks and salary-cap nominations can be automatic.</li><li>Bids never exceed the calculated maximum or violate the $1-per-slot reserve.</li><li>Turn Auto-Draft off at any time.</li></ul><div><button className="secondary-button" onClick={() => setAutoWarning(false)}>Cancel</button><button className="danger-button" onClick={() => { setAutoDraft(true); setAutoWarning(false); setActionState("Auto-Draft armed. Waiting for your ESPN turn."); }}>Enable Auto-Draft</button></div></div></div>}
    <footer><span>DraftForge AI · draft-only ESPN control room</span><span>{draftedIds.size} drafted · five-source deterministic consensus</span></footer>
  </main>;
}
