import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_GATE_POLICY,
  deriveGateSummary,
  initGatePolicy,
  loadGatePolicy,
  normalizeGateResult,
} from "../src/peers/gates.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-gates-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("gate policy initializes with deterministic defaults", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initGatePolicy(root);
    assert.equal(result.created.length, 1);

    const policy = await loadGatePolicy(root);
    assert.equal(policy.version, 1);
    assert.equal(policy.gates.find((gate) => gate.id === "test").command, "npm test");
    assert.equal(DEFAULT_GATE_POLICY.gates.some((gate) => gate.phase === "deterministic"), true);
  });
});

test("gate summary marks missing required gates as pending", () => {
  const summary = deriveGateSummary({
    policy: {
      version: 1,
      gates: [
        { id: "test", required: true },
        { id: "pack", required: true },
        { id: "review", required: false },
      ],
    },
    results: {
      test: normalizeGateResult({ gateId: "test", status: "pass", evidence: "passed" }),
      review: normalizeGateResult({ gateId: "review", status: "fail", evidence: "review issue" }),
    },
  });

  assert.equal(summary.requiredPassed, false);
  assert.deepEqual(summary.pendingRequiredGateIds, ["pack"]);
  assert.deepEqual(summary.failedGateIds, ["review"]);
});
