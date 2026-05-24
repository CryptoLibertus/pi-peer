import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_EVAL_MANIFESTS,
  CONTEXT_EVALS_FILE,
  deriveEvalSuiteSummary,
  formatEvalSuiteSummary,
  initEvalManifests,
  loadEvalManifests,
} from "../src/peers/evals.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-evals-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("eval manifests initialize task, context, and scenario suites", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initEvalManifests(root);
    assert.equal(result.created.length, 3);

    const manifests = await loadEvalManifests(root);
    assert.equal(manifests.task.version, 1);
    assert.equal(manifests.context.version, 1);
    assert.equal(manifests.scenario.version, 1);
    assert.equal(DEFAULT_EVAL_MANIFESTS.scenario.evals.some((item) => item.id === "peer-factory-run"), true);

    const summary = deriveEvalSuiteSummary(manifests);
    assert.equal(summary.totalEvalCount > 0, true);
    assert.equal(summary.suiteCounts.scenario, manifests.scenario.evals.length);
    assert.match(formatEvalSuiteSummary(summary), /Eval suites: total/);
  });
});

test("eval manifest init skips existing files unless overwrite is true", async (t) => {
  await withRoot(t, async (root) => {
    await initEvalManifests(root);
    const custom = {
      version: 1,
      suite: "context",
      evals: [{ id: "custom-context-eval", required: true }],
    };
    await writeFile(join(root, CONTEXT_EVALS_FILE), `${JSON.stringify(custom, null, 2)}\n`, "utf8");

    const skipped = await initEvalManifests(root);
    assert.equal(skipped.skipped.includes(CONTEXT_EVALS_FILE), true);
    assert.equal((await loadEvalManifests(root)).context.evals[0].id, "custom-context-eval");

    const overwritten = await initEvalManifests(root, { overwrite: true });
    assert.equal(overwritten.created.includes(CONTEXT_EVALS_FILE), true);
    assert.equal((await loadEvalManifests(root)).context.evals[0].id, "context-patch-requires-eval");
  });
});

test("eval manifests load defaults for missing files and reject corrupt json clearly", async (t) => {
  await withRoot(t, async (root) => {
    const manifests = await loadEvalManifests(root);
    assert.equal(manifests.task.evals.some((item) => item.id === "gate-failure-rework"), true);

    await initEvalManifests(root);
    await writeFile(join(root, ".pi/evals/context-evals.json"), "{bad json", "utf8");

    await assert.rejects(loadEvalManifests(root), /corrupt peer eval manifest context: /);
  });
});
