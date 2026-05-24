import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { deriveGoalState, loadPeerGoalBoard } from "../src/peers/goal-board.mjs";
import {
  DEFAULT_SELF_IMPROVE_MAX_LOOPS,
  SELF_IMPROVE_CONSTITUTION_FILE,
  SELF_IMPROVE_EXPERIMENTS_FILE,
  SELF_IMPROVE_GOALS_FILE,
  formatSelfImproveRunResult,
  formatSelfImproveStatus,
  initSelfImprove,
  loadSelfImproveState,
  startSelfImproveRun,
} from "../src/peers/self-improve.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-self-improve-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return fn(root);
}

test("self-improve init creates constitution, goals, and experiment ledger safely", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initSelfImprove(root, { peerId: "tester" });
    assert.deepEqual(result.created.sort(), [SELF_IMPROVE_CONSTITUTION_FILE, SELF_IMPROVE_EXPERIMENTS_FILE, SELF_IMPROVE_GOALS_FILE].sort());
    assert.match(await readFile(join(root, SELF_IMPROVE_CONSTITUTION_FILE), "utf8"), /Promotion rules/);
    assert.equal(JSON.parse(await readFile(join(root, SELF_IMPROVE_GOALS_FILE), "utf8")).version, 1);

    const second = await initSelfImprove(root);
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.includes(SELF_IMPROVE_CONSTITUTION_FILE), true);
  });
});

test("self-improve run creates bounded goal-board work and experiment record", async (t) => {
  await withRoot(t, async (root) => {
    const result = await startSelfImproveRun(root, {
      objective: "Improve peer closure safety",
      loops: 3,
      lanes: ["research", "review"],
      paths: ["src/peers/goal-board.mjs"],
      evals: ["npm test"],
      peers: ["worker2"],
      durationMs: 60_000,
      autoCommit: true,
      peerId: "planner",
    });

    assert.match(result.runId, /^rsi_/);
    assert.equal(result.loops, 3);
    assert.equal(result.autoCommit, true);
    const board = await loadPeerGoalBoard(root);
    const state = deriveGoalState(board.goals[result.goalId]);
    assert.equal(state.workItems.length, 3);
    assert.equal(state.openWorkItems.length, 3);
    assert.equal(state.openProposals.length, 2);
    assert.deepEqual(state.workItems[1].dependsOn, ["loop-001"]);
    assert.equal(state.closurePolicy.minPassingVotes, 1);

    const experimentText = await readFile(join(root, SELF_IMPROVE_EXPERIMENTS_FILE), "utf8");
    assert.match(experimentText, /"type":"run-started"/);
    assert.match(experimentText, /"autoCommit":true/);
    assert.match(formatSelfImproveRunResult(result), /Self-improvement run/);
    assert.match(formatSelfImproveRunResult({ ...result, dispatchRequested: true, peers: [], durationMs: 60_000 }), /no active compatible peers were resolved/);
    assert.match(formatSelfImproveRunResult({ ...result, dispatchRequested: true, peers: ["worker2"], durationMs: undefined }), /provide --duration/);
    assert.match(formatSelfImproveRunResult({ ...result, peers: [] }), /Add --dispatch with --duration/);
  });
});

test("self-improve run can emit factory metadata", async (t) => {
  await withRoot(t, async (root) => {
    const result = await startSelfImproveRun(root, {
      objective: "Improve verification",
      loops: 1,
      peerId: "planner",
      factory: true,
    });

    assert.equal(result.factory?.source, "self-improve");
    assert.equal(result.factory?.objective, "Improve verification");
  });
});

test("self-improve loop count is bounded", async (t) => {
  await withRoot(t, async (root) => {
    await assert.rejects(
      startSelfImproveRun(root, { objective: "too much", loops: DEFAULT_SELF_IMPROVE_MAX_LOOPS + 1, peerId: "planner" }),
      /bounded to 100/,
    );
  });
});

test("self-improve status summarizes configured goals and recent runs", async (t) => {
  await withRoot(t, async (root) => {
    assert.match(formatSelfImproveStatus(await loadSelfImproveState(root)), /not initialized/);
    const result = await startSelfImproveRun(root, { objective: "Improve observability", loops: 1, peerId: "planner" });
    const status = formatSelfImproveStatus(await loadSelfImproveState(root));
    assert.match(status, /constitution: present/);
    assert.match(status, /experiments: 1/);
    assert.match(status, new RegExp(result.runId));
  });
});
