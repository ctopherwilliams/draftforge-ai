import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard reload validates prior audit before recovery and restores only after authenticated parity", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const recoveryFlow = source.match(/if \(recoveryPayload\) window\.setTimeout\(async \(\) => \{[\s\S]*?\n\s{6}\}, 0\);/)?.[0] || "";
  assert.ok(recoveryFlow.length > 0);
  assert.ok(recoveryFlow.indexOf("fetch(`/api/draft-day") < recoveryFlow.indexOf('sendToExtension("RECOVER_LIVE_WORKSPACE"'));
  assert.match(recoveryFlow, /validateLiveControlRecoveryCandidate/);
  assert.match(recoveryFlow, /commandCenterSessionId: validated\.candidate\.commandCenterSessionId/);

  const importFlow = source.match(/if \(type === "DF_IMPORT_SUCCESS"[\s\S]*?if \(type === "DF_DRAFT_UPDATE"\)/)?.[0] || "";
  assert.match(importFlow, /validateLiveControlRecoveryImport/);
  assert.match(importFlow, /autopickActive: importedContext\?\.autopickActive/);
  assert.match(importFlow, /actionTelemetryRef\.current = recoveredCandidate/);
  assert.match(importFlow, /recoveredCandidate\.snapshot\.sleeperEvidence\.candidates/);
  assert.match(importFlow, /liveControlRef\.current = restoredControl/);
  assert.match(importFlow, /setSettingsConfirmed\(recoveredCandidate \? false : watchedAutoArm\)/);
});
