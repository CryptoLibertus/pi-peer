import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContextPatch,
  CONTEXT_DIR,
  CONTEXT_PATCHES_FILE,
  deriveContextLifecycleState,
  formatContextLifecycleStatus,
  loadContextLifecycle,
  recordContextEvalResult,
} from "../src/peers/context-lifecycle.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-context-life-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("context patch ledger records trigger, change, metric, eval, owner, and review date", async (t) => {
  await withRoot(t, async (root) => {
    const patch = await appendContextPatch(root, {
      trigger: "handoff failures repeated",
      change: "Require Verification heading in peer handoffs",
      metric: "missing verification handoff count",
      evalName: "handoff-quality",
      owner: "planner-a",
      reviewDate: "2026-06-24",
    });

    assert.match(patch.patchId, /^ctx_/);

    const state = deriveContextLifecycleState(await loadContextLifecycle(root));
    assert.equal(state.patches.length, 1);
    assert.equal(state.patches[0].owner, "planner-a");
    assert.match(formatContextLifecycleStatus(state), /patches 1/);
  });
});

test("context eval results attach to patch ids", async (t) => {
  await withRoot(t, async (root) => {
    const patch = await appendContextPatch(root, {
      trigger: "review misses",
      change: "Add review checklist",
      metric: "review miss rate",
      evalName: "review-checklist",
      owner: "reviewer-a",
      reviewDate: "2026-06-24",
    });

    await recordContextEvalResult(root, {
      patchId: patch.patchId,
      evalName: "review-checklist",
      status: "pass",
      evidence: "scenario eval passed",
    });

    const state = deriveContextLifecycleState(await loadContextLifecycle(root));
    assert.equal(state.evalResults.length, 1);
    assert.equal(state.patchEvalStatus[patch.patchId], "pass");
  });
});

test("context lifecycle loader throws on corrupt middle records and ignores trailing partials", async (t) => {
  await withRoot(t, async (root) => {
    await mkdir(join(root, CONTEXT_DIR), { recursive: true });
    const valid = JSON.stringify({
      type: "context-patch",
      patchId: "ctx_valid",
      trigger: "handoff failures",
      change: "Add handoff template",
      metric: "failure count",
      evalName: "handoff-quality",
      owner: "planner-a",
      reviewDate: "2026-06-24",
      at: "2026-05-24T00:00:00.000Z",
    });

    await writeFile(join(root, CONTEXT_PATCHES_FILE), `${valid}\n{bad json}\n${valid}\n`, "utf8");
    await assert.rejects(loadContextLifecycle(root), /corrupt context patch ledger record at line 2/);

    await writeFile(join(root, CONTEXT_PATCHES_FILE), `${valid}\n{bad json`, "utf8");
    const loaded = await loadContextLifecycle(root);
    assert.equal(loaded.patches.length, 1);
    assert.equal(loaded.warnings[0].type, "trailing-corrupt-record");
  });
});
