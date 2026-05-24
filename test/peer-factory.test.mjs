import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FACTORY_GATES_FILE,
  FACTORY_REWORK_POLICY_FILE,
  FACTORY_RUNS_FILE,
  appendFactoryRunRecord,
  deriveFactoryState,
  formatFactoryStatus,
  initFactory,
  loadFactoryRuns,
  startFactoryRun,
} from "../src/peers/factory.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-factory-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("factory init creates gate policy, rework policy, and append-only run ledger", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initFactory(root);

    assert.deepEqual(result.created.sort(), [
      FACTORY_GATES_FILE,
      FACTORY_REWORK_POLICY_FILE,
      FACTORY_RUNS_FILE,
    ].sort());

    const gates = JSON.parse(await readFile(join(root, FACTORY_GATES_FILE), "utf8"));
    assert.equal(gates.version, 1);
    assert.equal(gates.gates.some((gate) => gate.id === "test"), true);

    const second = await initFactory(root);
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.includes(FACTORY_RUNS_FILE), true);
  });
});

test("factory run records start, attempts, gates, and terminal status", async (t) => {
  await withRoot(t, async (root) => {
    const run = await startFactoryRun(root, {
      objective: "Improve protocol layer",
      goalId: "goal_123",
      peerId: "planner-a",
      paths: ["src/peers"],
      gates: ["test", "pack"],
      source: "peer-do",
    });

    assert.match(run.runId, /^fac_/);
    await appendFactoryRunRecord(root, { type: "attempt-started", runId: run.runId, attempt: 1, peerId: "worker-a" });
    await appendFactoryRunRecord(root, { type: "gate-result", runId: run.runId, gateId: "test", status: "pass", evidence: "npm test passed" });
    await appendFactoryRunRecord(root, { type: "run-completed", runId: run.runId, status: "verified" });

    const loaded = await loadFactoryRuns(root);
    const state = deriveFactoryState(loaded.records);

    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].status, "verified");
    assert.equal(state.runs[0].attempts.length, 1);
    assert.equal(state.runs[0].gateResults.test.status, "pass");
    assert.match(formatFactoryStatus(state), /verified 1/);
  });
});
