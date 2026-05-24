import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContextPatch,
  appendContextRetro,
  CONTEXT_DIR,
  CONTEXT_EVAL_RESULTS_FILE,
  CONTEXT_PATCHES_FILE,
  CONTEXT_RETROS_FILE,
  contextPatchHasPassingEval,
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

test("context eval results must match patch id and eval name to close patches", async (t) => {
  await withRoot(t, async (root) => {
    const patch = await appendContextPatch(root, {
      trigger: "handoff failures",
      change: "Add handoff checklist",
      metric: "handoff miss rate",
      evalName: "handoff-quality",
      owner: "planner-a",
      reviewDate: "2026-06-24",
    });

    await recordContextEvalResult(root, {
      patchId: patch.patchId,
      evalName: "wrong-eval",
      status: "pass",
      evidence: "wrong scenario passed",
    });
    await recordContextEvalResult(root, {
      patchId: "ctx_unknown",
      evalName: "handoff-quality",
      status: "pass",
      evidence: "unknown patch scenario passed",
    });

    const state = deriveContextLifecycleState(await loadContextLifecycle(root));
    assert.equal(state.patchEvalStatus[patch.patchId], undefined);
    assert.equal(state.openPatches.length, 1);
    assert.equal(state.warnings.length, 2);
    assert.match(state.warnings[0].message, /does not match patch evalName/);
    assert.match(state.warnings[1].message, /references unknown patchId/);
  });
});

test("context lifecycle uses latest matching eval result status", async (t) => {
  await withRoot(t, async (root) => {
    const failThenPass = await appendContextPatch(root, {
      trigger: "review misses",
      change: "Add review checklist",
      metric: "review miss rate",
      evalName: "review-checklist",
      owner: "reviewer-a",
      reviewDate: "2026-06-24",
    });
    const passThenFail = await appendContextPatch(root, {
      trigger: "handoff misses",
      change: "Add handoff checklist",
      metric: "handoff miss rate",
      evalName: "handoff-checklist",
      owner: "planner-a",
      reviewDate: "2026-06-24",
    });

    await recordContextEvalResult(root, { patchId: failThenPass.patchId, evalName: "review-checklist", status: "fail", evidence: "first run failed" });
    await recordContextEvalResult(root, { patchId: failThenPass.patchId, evalName: "review-checklist", status: "pass", evidence: "second run passed" });
    await recordContextEvalResult(root, { patchId: passThenFail.patchId, evalName: "handoff-checklist", status: "pass", evidence: "first run passed" });
    await recordContextEvalResult(root, { patchId: passThenFail.patchId, evalName: "handoff-checklist", status: "fail", evidence: "second run failed" });

    const state = deriveContextLifecycleState(await loadContextLifecycle(root));
    assert.equal(state.patchEvalStatus[failThenPass.patchId], "pass");
    assert.equal(state.patchEvalStatus[passThenFail.patchId], "fail");
    assert.deepEqual(state.openPatches.map((patch) => patch.patchId), [passThenFail.patchId]);
    assert.deepEqual(state.failingEvalResults.map((result) => result.patchId), [passThenFail.patchId]);
  });
});

test("context patch pass check requires existing patch and latest matching eval pass", async (t) => {
  await withRoot(t, async (root) => {
    const closed = await appendContextPatch(root, {
      trigger: "review misses",
      change: "Add review checklist",
      metric: "review miss rate",
      evalName: "review-checklist",
      owner: "reviewer-a",
      reviewDate: "2026-06-24",
    });
    const reopened = await appendContextPatch(root, {
      trigger: "handoff misses",
      change: "Add handoff checklist",
      metric: "handoff miss rate",
      evalName: "handoff-checklist",
      owner: "planner-a",
      reviewDate: "2026-06-24",
    });

    await recordContextEvalResult(root, { patchId: closed.patchId, evalName: "review-checklist", status: "fail", evidence: "first run failed" });
    await recordContextEvalResult(root, { patchId: closed.patchId, evalName: "review-checklist", status: "pass", evidence: "second run passed" });
    await recordContextEvalResult(root, { patchId: reopened.patchId, evalName: "handoff-checklist", status: "pass", evidence: "first run passed" });
    await recordContextEvalResult(root, { patchId: reopened.patchId, evalName: "handoff-checklist", status: "fail", evidence: "second run failed" });

    const state = deriveContextLifecycleState(await loadContextLifecycle(root));
    assert.equal(contextPatchHasPassingEval(state, closed.patchId), true);
    assert.equal(contextPatchHasPassingEval(state, reopened.patchId), false);
    assert.equal(contextPatchHasPassingEval(state, "ctx_missing"), false);
  });
});

test("context patch pass check works on raw lifecycle state", async () => {
  const patch = {
    patchId: "ctx_raw",
    evalName: "raw-eval",
  };
  const state = {
    patches: [patch],
    evalResults: [
      { patchId: patch.patchId, evalName: "raw-eval", status: "pass" },
    ],
  };

  assert.equal(contextPatchHasPassingEval(state, patch.patchId), true);
});

test("context patch pass check ignores stale derived status", async () => {
  const patch = {
    patchId: "ctx_stale",
    evalName: "stale-eval",
  };
  const state = {
    patches: [patch],
    evalResults: [
      { patchId: patch.patchId, evalName: "stale-eval", status: "pass" },
      { patchId: patch.patchId, evalName: "stale-eval", status: "fail" },
    ],
    patchEvalStatus: {
      [patch.patchId]: "pass",
    },
  };

  assert.equal(contextPatchHasPassingEval(state, patch.patchId), false);
});

test("context patch pass check ignores mismatched eval names", async () => {
  const patch = {
    patchId: "ctx_mismatch",
    evalName: "expected-eval",
  };
  const state = {
    patches: [patch],
    evalResults: [
      { patchId: patch.patchId, evalName: "wrong-eval", status: "pass" },
    ],
  };

  assert.equal(contextPatchHasPassingEval(state, patch.patchId), false);
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

test("context lifecycle appenders refuse trailing corrupt partial records", async (t) => {
  await withRoot(t, async (root) => {
    await mkdir(join(root, CONTEXT_DIR), { recursive: true });
    const validPatch = JSON.stringify({
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
    const validEval = JSON.stringify({
      type: "context-eval-result",
      patchId: "ctx_valid",
      evalName: "handoff-quality",
      status: "pass",
      evidence: "scenario passed",
      at: "2026-05-24T00:00:00.000Z",
    });
    const validRetro = JSON.stringify({
      type: "context-retro",
      summary: "handoff misses repeated",
      at: "2026-05-24T00:00:00.000Z",
    });

    await writeFile(join(root, CONTEXT_PATCHES_FILE), `${validPatch}\n{bad json`, "utf8");
    await assert.rejects(
      appendContextPatch(root, {
        trigger: "review misses",
        change: "Add review checklist",
        metric: "miss rate",
        evalName: "review-quality",
        owner: "reviewer-a",
        reviewDate: "2026-06-24",
      }),
      /cannot append context patch ledger record after trailing corrupt ledger record at line 2/,
    );

    await writeFile(join(root, CONTEXT_EVAL_RESULTS_FILE), `${validEval}\n{bad json`, "utf8");
    await assert.rejects(
      recordContextEvalResult(root, {
        patchId: "ctx_valid",
        evalName: "handoff-quality",
        status: "pass",
        evidence: "scenario passed again",
      }),
      /cannot append context eval result ledger record after trailing corrupt ledger record at line 2/,
    );

    await writeFile(join(root, CONTEXT_RETROS_FILE), `${validRetro}\n{bad json`, "utf8");
    await assert.rejects(
      appendContextRetro(root, { summary: "review misses repeated" }),
      /cannot append context retro ledger record after trailing corrupt ledger record at line 2/,
    );
  });
});

test("context lifecycle loader throws on trailing valid json with invalid schema", async (t) => {
  await withRoot(t, async (root) => {
    await mkdir(join(root, CONTEXT_DIR), { recursive: true });
    const invalidPatch = JSON.stringify({
      type: "context-patch",
      patchId: "ctx_invalid",
      trigger: "handoff failures",
      change: "Add handoff template",
      metric: "failure count",
      evalName: "handoff-quality",
      owner: "planner-a",
    });

    await writeFile(join(root, CONTEXT_PATCHES_FILE), invalidPatch, "utf8");
    await assert.rejects(loadContextLifecycle(root), /context patch requires reviewDate/);
  });
});

test("context patch review date requires strict valid yyyy-mm-dd", async (t) => {
  await withRoot(t, async (root) => {
    const basePatch = {
      trigger: "handoff failures",
      change: "Add handoff template",
      metric: "failure count",
      evalName: "handoff-quality",
      owner: "planner-a",
    };

    await assert.rejects(appendContextPatch(root, { ...basePatch, reviewDate: "06/24/2026" }), /reviewDate must be YYYY-MM-DD/);
    await assert.rejects(appendContextPatch(root, { ...basePatch, reviewDate: "2026-02-31" }), /reviewDate must be a valid calendar date/);
  });
});
