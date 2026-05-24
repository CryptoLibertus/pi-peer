import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_GATE_POLICY,
  deriveGateSummary,
  formatGateSummary,
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
  assert.deepEqual(summary.blockingRequiredGateIds, ["pack"]);
  assert.deepEqual(summary.failedGateIds, ["review"]);
});

test("missing gate policy load returns deterministic defaults", async (t) => {
  await withRoot(t, async (root) => {
    const policy = await loadGatePolicy(root);

    assert.equal(policy.version, DEFAULT_GATE_POLICY.version);
    assert.deepEqual(policy.gates, DEFAULT_GATE_POLICY.gates);
  });
});

test("corrupt gate policy JSON throws a clear error", async (t) => {
  await withRoot(t, async (root) => {
    await mkdir(join(root, ".pi/factory"), { recursive: true });
    await writeFile(join(root, ".pi/factory/gates.json"), "{not json", "utf8");

    await assert.rejects(loadGatePolicy(root), /corrupt factory gate policy:/);
  });
});

test("structurally invalid gate policy falls back to defaults and fails closed", () => {
  const summary = deriveGateSummary({
    policy: { version: 1, gates: "oops" },
    results: {},
  });

  assert.equal(summary.requiredPassed, false);
  assert.deepEqual(summary.requiredGateIds, DEFAULT_GATE_POLICY.gates.filter((gate) => gate.required).map((gate) => gate.id));
  assert.notEqual(summary.requiredGateIds.length, 0);
});

test("loaded structurally invalid gate policy falls back to defaults", async (t) => {
  await withRoot(t, async (root) => {
    await mkdir(join(root, ".pi/factory"), { recursive: true });
    await writeFile(join(root, ".pi/factory/gates.json"), `${JSON.stringify({ version: 1, gates: "oops" })}\n`, "utf8");

    const policy = await loadGatePolicy(root);
    const summary = deriveGateSummary({ policy });

    assert.deepEqual(policy.gates, DEFAULT_GATE_POLICY.gates);
    assert.equal(summary.requiredPassed, false);
  });
});

test("all required gates passing allows optional failures to remain visible", () => {
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
      test: normalizeGateResult({ gateId: "test", status: "pass" }),
      pack: normalizeGateResult({ gateId: "pack", status: "pass" }),
      review: normalizeGateResult({ gateId: "review", status: "fail", evidence: "optional review failed" }),
    },
  });

  assert.equal(summary.requiredPassed, true);
  assert.deepEqual(summary.pendingRequiredGateIds, []);
  assert.deepEqual(summary.failedRequiredGateIds, []);
  assert.deepEqual(summary.failedGateIds, ["review"]);
});

test("required fail skip and pending gates are categorized separately", () => {
  const summary = deriveGateSummary({
    policy: {
      version: 1,
      gates: [
        { id: "test", required: true },
        { id: "pack", required: true },
        { id: "review", required: true },
      ],
    },
    results: {
      test: normalizeGateResult({ gateId: "test", status: "fail" }),
      pack: normalizeGateResult({ gateId: "pack", status: "skip" }),
    },
  });

  assert.equal(summary.requiredPassed, false);
  assert.deepEqual(summary.failedRequiredGateIds, ["test"]);
  assert.deepEqual(summary.skippedRequiredGateIds, ["pack"]);
  assert.deepEqual(summary.pendingRequiredGateIds, ["review"]);
  assert.deepEqual(summary.blockingRequiredGateIds, ["test", "pack", "review"]);
});

test("gate summary formatter includes required counts and categories", () => {
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
      test: normalizeGateResult({ gateId: "test", status: "fail" }),
      review: normalizeGateResult({ gateId: "review", status: "skip" }),
    },
  });

  const text = formatGateSummary(summary);

  assert.match(text, /required 0\/2/);
  assert.match(text, /failed required test/);
  assert.match(text, /pending required pack/);
  assert.match(text, /skipped review/);
});

test("gate result normalization preserves metadata and metrics fields", () => {
  const result = normalizeGateResult({
    gateId: "test",
    runId: "fac_123",
    attempt: 2,
    status: "pass",
    durationMs: 1234,
    exitCode: 0,
    command: "npm test",
    phase: "deterministic",
    model: "gpt-5",
    cost: 0.42,
    tokenCount: 1500,
    metadata: { shard: "unit" },
  });

  assert.equal(result.runId, "fac_123");
  assert.equal(result.attempt, 2);
  assert.equal(result.durationMs, 1234);
  assert.equal(result.exitCode, 0);
  assert.equal(result.command, "npm test");
  assert.equal(result.phase, "deterministic");
  assert.equal(result.model, "gpt-5");
  assert.equal(result.cost, 0.42);
  assert.equal(result.tokenCount, 1500);
  assert.deepEqual(result.metadata, { shard: "unit" });
});
