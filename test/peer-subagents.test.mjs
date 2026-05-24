import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { derivePeerControlState, loadPeerControlLedger } from "../src/peers/control-ledger.mjs";
import { appendPeerGoalEvent, createPeerGoal, deriveGoalState, loadPeerGoalBoard } from "../src/peers/goal-board.mjs";
import {
  cancelPeerSubagentRun,
  completePeerSubagentRun,
  formatPeerSubagentRunResult,
  formatPeerSubagentStatus,
  recordPeerSubagentRunProgress,
  resolveSubagentProvider,
  startPeerSubagentRun,
} from "../src/peers/subagents.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-subagents-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("missing provider returns manual blocked subrun without throwing", async (t) => {
  await withRoot(t, async (root) => {
    const result = await startPeerSubagentRun(root, {
      summary: "Review implementation",
      goalId: "goal_123",
      parentPeerId: "planner-a",
      provider: "pi-subagents",
      importModule: async () => undefined,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.provider, "pi-subagents");
    assert.match(result.message, /provider unavailable/i);

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns.length, 0);
    assert.equal(state.completedSubruns.length, 1);
    assert.equal(state.completedSubruns[0].status, "blocked");
  });
});

test("subrun progress, complete, and status format compact state", async (t) => {
  await withRoot(t, async (root) => {
    const started = await startPeerSubagentRun(root, {
      summary: "Private research team",
      goalId: "goal_123",
      parentPeerId: "researcher-a",
      provider: "manual",
      mode: "parallel",
    });
    const progress = await recordPeerSubagentRunProgress(root, {
      subrunId: started.subrunId,
      goalId: "goal_123",
      parentPeerId: "researcher-a",
      provider: "manual",
      summary: "Collected sources",
      artifactRefs: ["artifact:sources"],
    });
    const completed = await completePeerSubagentRun(root, {
      subrunId: started.subrunId,
      goalId: "goal_123",
      parentPeerId: "researcher-a",
      provider: "manual",
      summary: "Research synthesis complete",
      doneCount: 2,
      blockedCount: 0,
      artifactRefs: ["artifact:summary"],
    });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns.length, 0);
    assert.equal(state.completedSubruns.length, 1);
    assert.deepEqual(state.completedSubruns[0].artifactRefs, ["artifact:sources", "artifact:summary"]);

    const statusText = formatPeerSubagentStatus({ controlState: state });
    assert.match(statusText, /Subruns: 0 active · 1 completed/);
    assert.match(statusText, new RegExp(started.subrunId));
    assert.match(statusText, /done/);
    assert.match(statusText, /manual/);
    assert.match(statusText, /parallel/);
    assert.match(statusText, /done 2/);
    assert.match(statusText, /blocked 0/);
    assert.match(statusText, /artifact:sources,artifact:summary/);

    const progressText = formatPeerSubagentRunResult(progress);
    assert.match(progressText, /Subrun/);
    assert.match(progressText, new RegExp(started.subrunId));
    assert.match(progressText, /progress/);
    assert.match(progressText, /Collected sources/);
    assert.match(progressText, /artifact:sources/);

    const completeText = formatPeerSubagentRunResult(completed);
    assert.match(completeText, /Subrun/);
    assert.match(completeText, new RegExp(started.subrunId));
    assert.match(completeText, /done/);
    assert.match(completeText, /manual/);
    assert.match(completeText, /parallel/);
    assert.match(completeText, /Research synthesis complete/);
    assert.match(completeText, /done 2/);
    assert.match(completeText, /blocked 0/);
    assert.match(completeText, /artifact:summary/);
  });
});

test("completePeerSubagentRun can attach bounded subagent evidence to parent goal handoff", async (t) => {
  await withRoot(t, async (root) => {
    const goal = await createPeerGoal(root, { objective: "Ship private teams", peerId: "planner-a" });
    const started = await startPeerSubagentRun(root, {
      summary: "Parallel implementation checks",
      goalId: goal.id,
      parentPeerId: "worker-a",
      provider: "manual",
      mode: "parallel",
    });
    await completePeerSubagentRun(root, {
      subrunId: started.subrunId,
      goalId: goal.id,
      parentPeerId: "worker-a",
      provider: "manual",
      attachHandoff: true,
      childCount: 3,
      doneCount: 2,
      blockedCount: 1,
      artifactRefs: ["artifact:subrun"],
    });

    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goal.id]);
    const handoff = state.events.find((event) => event.type === "handoff" && event.taskId === started.subrunId);
    assert.ok(handoff);
    assert.equal(handoff.peerId, "worker-a");
    assert.deepEqual(handoff.metadata.subagentEvidence, {
      subrunId: started.subrunId,
      provider: "manual",
      mode: "parallel",
      childCount: 3,
      doneCount: 2,
      blockedCount: 1,
      artifactRefs: ["artifact:subrun"],
    });
  });
});

test("cancelPeerSubagentRun records terminal cancelled subrun", async (t) => {
  await withRoot(t, async (root) => {
    const started = await startPeerSubagentRun(root, {
      summary: "Cancelled team",
      goalId: "goal_123",
      parentPeerId: "planner-a",
      provider: "manual",
    });

    await cancelPeerSubagentRun(root, {
      subrunId: started.subrunId,
      goalId: "goal_123",
      parentPeerId: "planner-a",
      provider: "manual",
    });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns.length, 0);
    assert.equal(state.completedSubruns.length, 1);
    assert.equal(state.completedSubruns[0].status, "cancelled");
  });
});

test("subrun metadata includes curated toolset for parent peer role", async (t) => {
  await withRoot(t, async (root) => {
    const started = await startPeerSubagentRun(root, {
      summary: "Reviewer-backed checks",
      goalId: "goal_123",
      parentPeerId: "reviewer-a",
      parentPeerRole: "reviewer",
      provider: "manual",
    });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    const subrun = state.activeSubruns.find((run) => run.subrunId === started.subrunId);

    assert.ok(subrun);
    assert.equal(subrun.metadata.toolsetIds.includes("peer_get"), true);
    assert.equal(subrun.metadata.toolsetIds.includes("peer_send"), true);
  });
});

test("resolveSubagentProvider supports injected provider modules", async (t) => {
  await withRoot(t, async (root) => {
    const provider = await resolveSubagentProvider(root, {
      provider: "pi-subagents",
      importModule: async () => ({ startPeerSubagents: async () => ({ ok: true }) }),
    });

    assert.equal(provider.name, "pi-subagents");
    assert.equal(provider.available, true);
  });
});

test("provider starter failure records terminal subrun without throwing", async (t) => {
  await withRoot(t, async (root) => {
    const result = await startPeerSubagentRun(root, {
      summary: "Provider-backed review",
      goalId: "goal_123",
      parentPeerId: "planner-a",
      provider: "pi-subagents",
      importModule: async () => ({
        startPeerSubagents: async () => {
          throw new Error("provider crashed");
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
    assert.match(result.message, /provider crashed/);

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns.length, 0);
    assert.equal(state.completedSubruns.length, 1);
    assert.equal(state.completedSubruns[0].status, "error");
  });
});

test("partial attached subrun creates unresolved goal handoff until resolved", async (t) => {
  await withRoot(t, async (root) => {
    const goal = await createPeerGoal(root, { objective: "Ship partial teams", peerId: "planner-a" });
    await appendPeerGoalEvent(root, goal.id, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "ready except subrun" });
    const started = await startPeerSubagentRun(root, {
      summary: "Parallel checks",
      goalId: goal.id,
      parentPeerId: "worker-a",
      provider: "manual",
      mode: "parallel",
    });

    await completePeerSubagentRun(root, {
      subrunId: started.subrunId,
      goalId: goal.id,
      parentPeerId: "worker-a",
      provider: "manual",
      attachHandoff: true,
      childCount: 3,
      doneCount: 2,
      blockedCount: 1,
    });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goal.id]);
    assert.equal(state.unresolvedTaskHandoffs.length, 1);
    assert.equal(state.unresolvedTaskHandoffs[0].taskId, started.subrunId);
    assert.equal(state.readyToClose, false);

    await appendPeerGoalEvent(root, goal.id, {
      type: "resolve",
      peerId: "planner-a",
      resolves: state.unresolvedTaskHandoffs[0].handoffEventId,
      summary: "Accepted partial subrun evidence",
    });

    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goal.id]);
    assert.equal(state.unresolvedTaskHandoffs.length, 0);
    assert.equal(state.readyToClose, true);
  });
});

test("attached handoff evidence accumulates progress artifacts and counts", async (t) => {
  await withRoot(t, async (root) => {
    const goal = await createPeerGoal(root, { objective: "Ship accumulated teams", peerId: "planner-a" });
    const started = await startPeerSubagentRun(root, {
      summary: "Evidence team",
      goalId: goal.id,
      parentPeerId: "worker-a",
      provider: "manual",
      mode: "parallel",
    });
    await recordPeerSubagentRunProgress(root, {
      subrunId: started.subrunId,
      artifactRefs: ["artifact:sources"],
      childCount: 3,
      doneCount: 1,
      blockedCount: 2,
    });
    await recordPeerSubagentRunProgress(root, {
      subrunId: started.subrunId,
      artifactRefs: ["artifact:notes"],
      doneCount: 2,
      blockedCount: 1,
    });

    await completePeerSubagentRun(root, {
      subrunId: started.subrunId,
      attachHandoff: true,
      artifactRefs: ["artifact:summary"],
    });

    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goal.id]);
    const handoff = state.events.find((event) => event.type === "handoff" && event.taskId === started.subrunId);
    assert.deepEqual(handoff.metadata.subagentEvidence, {
      subrunId: started.subrunId,
      provider: "manual",
      mode: "parallel",
      childCount: 3,
      doneCount: 2,
      blockedCount: 1,
      artifactRefs: ["artifact:sources", "artifact:notes", "artifact:summary"],
    });
  });
});

test("unknown provider names are not dynamically imported", async (t) => {
  await withRoot(t, async (root) => {
    let importCalled = false;
    const provider = await resolveSubagentProvider(root, {
      provider: "some-random-package",
      importModule: async () => {
        importCalled = true;
        throw new Error("should not import unknown provider");
      },
    });

    assert.equal(importCalled, false);
    assert.equal(provider.name, "some-random-package");
    assert.equal(provider.available, false);
  });
});
