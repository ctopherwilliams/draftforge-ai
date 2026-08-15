import assert from "node:assert/strict";
import test from "node:test";
import { selectUniqueEspnContext } from "../extension/context-selector.js";

test("exact ESPN import selects one unique matching league", () => {
  const selected = selectUniqueEspnContext([
    { leagueId: "701", tabId: 41, inDraftRoom: true },
    { leagueId: "702", tabId: 42, inDraftRoom: true },
  ], "701");
  assert.equal(selected?.tabId, 41);
});

test("exact ESPN import prefers one live room over an ordinary same-league page", () => {
  const selected = selectUniqueEspnContext([
    { leagueId: "701", tabId: 41, inDraftRoom: false },
    { leagueId: "701", tabId: 42, inDraftRoom: true },
  ], "701");
  assert.equal(selected?.tabId, 42);
});

test("exact ESPN import fails closed when two live rooms match", () => {
  const selected = selectUniqueEspnContext([
    { leagueId: "701", tabId: 41, inDraftRoom: true },
    { leagueId: "701", tabId: 42, inDraftRoom: true },
  ], "701");
  assert.equal(selected, null);
});

test("ambient ESPN context still prefers the newest live room", () => {
  const selected = selectUniqueEspnContext([
    { leagueId: "701", tabId: 41, inDraftRoom: false, lastAccessed: 300 },
    { leagueId: "702", tabId: 42, inDraftRoom: true, lastAccessed: 100 },
    { leagueId: "703", tabId: 43, inDraftRoom: true, lastAccessed: 200 },
  ]);
  assert.equal(selected?.tabId, 43);
});
