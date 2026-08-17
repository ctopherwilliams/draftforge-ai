import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the ESPN draft control room", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>DraftForge AI — Fantasy Football Draft Coach<\/title>/i);
  assert.match(html, /Import your real draft/);
  assert.match(html, /weighted consensus/i);
  assert.match(html, /Auto-Draft/);
  assert.match(html, /DO THIS NOW/);
  assert.match(html, /ROSTER CONTROL/);
  assert.match(html, /Live player board/);
  assert.match(html, /Why this is the move/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|NFL\.com/i);
});
