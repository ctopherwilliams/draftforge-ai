import assert from "node:assert/strict";
import test from "node:test";
import { draftUiReducer, INITIAL_DRAFT_UI_STATE } from "../app/lib/draft-ui-state.ts";

test("draft presentation panels update through one focused reducer", () => {
  const opened = draftUiReducer(INITIAL_DRAFT_UI_STATE, { type: "set", key: "sourcesOpen", value: true });
  assert.equal(opened.sourcesOpen, true);
  assert.equal(opened.settingsOpen, true);
  assert.equal(draftUiReducer(opened, { type: "set", key: "sourcesOpen", value: true }), opened);
  assert.equal(draftUiReducer(opened, { type: "toggle", key: "sourcesOpen" }).sourcesOpen, false);
});
