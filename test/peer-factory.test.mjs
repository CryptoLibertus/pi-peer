import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FACTORY_GATES_FILE,
  FACTORY_REWORK_POLICY_FILE,
  FACTORY_RUNS_FILE,
  appendFactoryRunRecord,
  deriveFactoryState,
  findFactoryRunByLink,
  formatFactoryStatus,
  initFactory,
  loadFactoryReworkPolicy,
  loadFactoryRuns,
  startLinkedFactoryRun,
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
    const reworkPolicy = JSON.parse(await readFile(join(root, FACTORY_REWORK_POLICY_FILE), "utf8"));
    assert.equal(reworkPolicy.maxAttempts, 5);
    assert.equal(reworkPolicy.steps.some((step) => step.action === "context-or-tool-patch"), true);

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

test("factory linked runs can be found and reused by source and goal", async (t) => {
  await withRoot(t, async (root) => {
    const first = await startLinkedFactoryRun(root, {
      objective: "Ship linked workflow",
      goalId: "goal_linked",
      peerId: "planner-a",
      source: "peer-do",
    });
    const second = await startLinkedFactoryRun(root, {
      objective: "Ship linked workflow again",
      goalId: "goal_linked",
      peerId: "planner-b",
      source: "peer-do",
    });

    const loaded = await loadFactoryRuns(root);
    const state = deriveFactoryState(loaded.records);
    const found = findFactoryRunByLink(state, { goalId: "goal_linked", source: "peer-do" });

    assert.equal(second.runId, first.runId);
    assert.equal(second.reused, true);
    assert.equal(state.runs.length, 1);
    assert.equal(found.runId, first.runId);
  });
});

test("factory run loader treats missing ledger as empty", async (t) => {
  await withRoot(t, async (root) => {
    const loaded = await loadFactoryRuns(root);

    assert.deepEqual(loaded, { records: [], warnings: [] });
  });
});

test("factory run loader warns and ignores corrupt trailing partial record", async (t) => {
  await withRoot(t, async (root) => {
    await initFactory(root);
    await appendFactoryRunRecord(root, { type: "run-started", runId: "fac_partial", objective: "Recover partial ledger" });
    await writeFile(join(root, FACTORY_RUNS_FILE), `${JSON.stringify({ type: "run-started", runId: "fac_partial", objective: "Recover partial ledger" })}\n{"type":`, "utf8");

    const loaded = await loadFactoryRuns(root);

    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.warnings.length, 1);
    assert.equal(loaded.warnings[0].type, "trailing-corrupt-record");
  });
});

test("factory run loader throws on corrupt middle record", async (t) => {
  await withRoot(t, async (root) => {
    await initFactory(root);
    await writeFile(join(root, FACTORY_RUNS_FILE), [
      JSON.stringify({ type: "run-started", runId: "fac_middle", objective: "Reject middle corruption" }),
      "{not json",
      JSON.stringify({ type: "run-completed", runId: "fac_middle", status: "verified" }),
      "",
    ].join("\n"), "utf8");

    await assert.rejects(loadFactoryRuns(root), /corrupt factory run ledger record at line 2/);
  });
});

test("factory rework policy loader falls back and reads custom policy", async (t) => {
  await withRoot(t, async (root) => {
    const missing = await loadFactoryReworkPolicy(root);
    assert.equal(missing.maxAttempts, 5);

    await initFactory(root);
    await writeFile(join(root, FACTORY_REWORK_POLICY_FILE), `${JSON.stringify({
      version: 1,
      maxAttempts: 2,
      repeatedFailureThreshold: 2,
      steps: [
        { attempt: 1, action: "fix-directly" },
        { attempt: 2, action: "escalate-human" },
      ],
    })}\n`, "utf8");

    const custom = await loadFactoryReworkPolicy(root);
    assert.equal(custom.maxAttempts, 2);
    assert.equal(custom.repeatedFailureThreshold, 2);
  });
});

test("factory rework policy loader throws clear error on corrupt json", async (t) => {
  await withRoot(t, async (root) => {
    await initFactory(root);
    await writeFile(join(root, FACTORY_REWORK_POLICY_FILE), "{bad json", "utf8");

    await assert.rejects(loadFactoryReworkPolicy(root), /corrupt factory rework policy:/);
  });
});

test("failed attempt completion marks run terminal and inactive", async (t) => {
  await withRoot(t, async (root) => {
    const run = await startFactoryRun(root, { objective: "Fail fast", goalId: "goal_fail" });
    await appendFactoryRunRecord(root, { type: "attempt-started", runId: run.runId, attempt: 1, peerId: "worker-a" });
    await appendFactoryRunRecord(root, { type: "attempt-completed", runId: run.runId, attempt: 1, status: "failed", evidence: "tests failed" });

    const state = deriveFactoryState((await loadFactoryRuns(root)).records);

    assert.equal(state.runs[0].status, "failed");
    assert.equal(state.runs[0].attempts[0].status, "failed");
    assert.equal(state.runs[0].failures[0].evidence, "tests failed");
    assert.equal(state.activeRuns.length, 0);
    assert.equal(state.completedRuns.length, 1);
  });
});

test("repeated gate results keep the latest result per gate and format gates deterministically", async (t) => {
  await withRoot(t, async (root) => {
    const run = await startFactoryRun(root, { objective: "Retest gate" });
    await appendFactoryRunRecord(root, { type: "gate-result", runId: run.runId, gateId: "z-pack", status: "fail", evidence: "pack failed" });
    await appendFactoryRunRecord(root, { type: "gate-result", runId: run.runId, gateId: "a-test", status: "pass", evidence: "test passed" });
    await appendFactoryRunRecord(root, { type: "gate-result", runId: run.runId, gateId: "z-pack", status: "pass", evidence: "pack passed" });

    const state = deriveFactoryState((await loadFactoryRuns(root)).records);
    const text = formatFactoryStatus(state);

    assert.equal(state.runs[0].gateResults["z-pack"].status, "pass");
    assert.equal(state.runs[0].gateResults["z-pack"].evidence, "pack passed");
    assert.match(text, /gates a-test:pass, z-pack:pass/);
  });
});

test("passing gate retry clears stale blocked status from prior failed gate", async (t) => {
  await withRoot(t, async (root) => {
    const run = await startFactoryRun(root, { objective: "Retry failed gate" });
    await appendFactoryRunRecord(root, { type: "gate-result", runId: run.runId, gateId: "test", status: "fail", evidence: "test failed" });
    await appendFactoryRunRecord(root, { type: "gate-result", runId: run.runId, gateId: "test", status: "pass", evidence: "test passed" });

    const state = deriveFactoryState((await loadFactoryRuns(root)).records);

    assert.equal(state.runs[0].gateResults.test.status, "pass");
    assert.equal(state.runs[0].status, "running");
    assert.equal(state.activeRuns.length, 1);
    assert.equal(state.completedRuns.length, 0);
  });
});

test("error attempt completion is terminal and inactive", async (t) => {
  await withRoot(t, async (root) => {
    const run = await startFactoryRun(root, { objective: "Error attempt" });
    await appendFactoryRunRecord(root, { type: "attempt-started", runId: run.runId, attempt: 1, peerId: "worker-a" });
    await appendFactoryRunRecord(root, { type: "attempt-completed", runId: run.runId, attempt: 1, status: "error", evidence: "provider crashed" });

    const state = deriveFactoryState((await loadFactoryRuns(root)).records);

    assert.equal(state.runs[0].status, "error");
    assert.equal(state.runs[0].attempts[0].status, "error");
    assert.equal(state.activeRuns.length, 0);
    assert.equal(state.completedRuns.length, 1);
  });
});

test("one rework cycle is counted once when requested and started are both logged", async (t) => {
  await withRoot(t, async (root) => {
    const run = await startFactoryRun(root, { objective: "Rework once" });
    await appendFactoryRunRecord(root, { type: "rework-requested", runId: run.runId, reworkId: "rw_1", summary: "Address review" });
    await appendFactoryRunRecord(root, { type: "rework-started", runId: run.runId, reworkId: "rw_1", peerId: "worker-a" });

    const state = deriveFactoryState((await loadFactoryRuns(root)).records);

    assert.equal(state.runs[0].reworkCount, 1);
    assert.equal(state.runs[0].status, "rework");
  });
});

test("factory state derives structured rework records and escalation", async (t) => {
  await withRoot(t, async (root) => {
    const run = await startFactoryRun(root, { objective: "Classify rework" });
    await appendFactoryRunRecord(root, {
      type: "failure-reported",
      runId: run.runId,
      summary: "tests failed",
      evidence: "AssertionError",
      metadata: { failureType: "test", owner: "worker-a" },
    });
    await appendFactoryRunRecord(root, {
      type: "context-patch-requested",
      runId: run.runId,
      summary: "same failure repeated",
      metadata: { action: "context-patch", failureType: "test", owner: "worker-a", reason: "Repeated test failure" },
    });
    await appendFactoryRunRecord(root, {
      type: "human-escalation",
      runId: run.runId,
      summary: "attempt limit reached",
      metadata: { action: "escalate-human", failureType: "test", owner: "worker-a", reason: "Maximum rework attempts reached" },
    });

    const state = deriveFactoryState((await loadFactoryRuns(root)).records);
    const derived = state.runs[0];

    assert.equal(derived.failures[0].failureType, "test");
    assert.equal(derived.failures[0].owner, "worker-a");
    assert.equal(derived.failures[0].summary, "tests failed");
    assert.equal(derived.reworkCount, 1);
    assert.equal(derived.escalationRequired, true);
    assert.equal(derived.latestReworkDecision.action, "escalate-human");
    assert.equal(derived.latestReworkDecision.failureType, "test");
  });
});

test("factory failure derivation preserves reason metadata as summary", async (t) => {
  await withRoot(t, async (root) => {
    const run = await startFactoryRun(root, { objective: "Preserve failure reason" });
    await appendFactoryRunRecord(root, {
      type: "failure-reported",
      runId: run.runId,
      metadata: { failureType: "test", reason: "unit test assertion failed" },
    });

    const state = deriveFactoryState((await loadFactoryRuns(root)).records);

    assert.equal(state.runs[0].failures[0].failureType, "test");
    assert.equal(state.runs[0].failures[0].summary, "unit test assertion failed");
  });
});

test("factory status summarizes active and terminal counts", async (t) => {
  await withRoot(t, async (root) => {
    const active = await startFactoryRun(root, { objective: "Still active" });
    const terminal = await startFactoryRun(root, { objective: "Verified terminal" });
    await appendFactoryRunRecord(root, { type: "attempt-started", runId: active.runId, attempt: 1 });
    await appendFactoryRunRecord(root, { type: "run-completed", runId: terminal.runId, status: "verified" });

    const state = deriveFactoryState((await loadFactoryRuns(root)).records);
    const text = formatFactoryStatus(state);

    assert.equal(state.activeRuns.length, 1);
    assert.equal(state.completedRuns.length, 1);
    assert.match(text, /Factory runs: 2 · active 1/);
    assert.match(text, /running 1/);
    assert.match(text, /verified 1/);
  });
});

test("blocking plan-review records derive terminal blocked state", async (t) => {
  await withRoot(t, async (root) => {
    await appendFactoryRunRecord(root, {
      type: "plan-review",
      runId: "plan:goal_123",
      goalId: "goal_123",
      status: "block",
      metadata: { verdict: "block" },
    });

    const state = deriveFactoryState((await loadFactoryRuns(root)).records);

    assert.equal(state.runs[0].status, "blocked");
    assert.equal(state.activeRuns.length, 0);
    assert.equal(state.completedRuns.length, 1);
  });
});
