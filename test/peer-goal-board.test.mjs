import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { appendPeerGoalEvent, closePeerGoal, createPeerGoal, deriveGoalState, derivePeerGoalScoutSuggestions, formatPeerGoal, formatPeerGoalList, formatPeerGoalScout, loadPeerGoalBoard } from "../src/peers/goal-board.mjs";

async function withGoal(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const goal = await createPeerGoal(root, { objective: "test goal", peerId: "tester" });
  return fn(root, goal.id);
}

test("repo-root write claims conflict with subpath write claims", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: "claim repo root",
      mode: "write",
      paths: ["."],
    });

    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "claim",
        peerId: "worker-b",
        summary: "claim src",
        mode: "write",
        paths: ["src"],
      }),
      /claim conflicts with active write claim/,
    );
  });
});

test("root-ish paths normalize to repo root for write-claim conflicts", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: "claim src",
      mode: "write",
      paths: ["src"],
    });

    for (const rootPath of ["./", "/"]) {
      await assert.rejects(
        appendPeerGoalEvent(root, goalId, {
          type: "claim",
          peerId: "worker-b",
          summary: `claim ${rootPath}`,
          mode: "write",
          paths: [rootPath],
        }),
        /claim conflicts with active write claim/,
      );
    }
  });
});

test("heartbeats cannot revive stale write claims over an active overlapping claim", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const staleClaim = await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: "claim src briefly",
      mode: "write",
      paths: ["src"],
      staleAfterMs: 1,
    });

    await delay(5);

    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-b",
      summary: "claim child path after first claim stales",
      mode: "write",
      paths: ["src/foo.js"],
    });

    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "heartbeat",
        peerId: "worker-a",
        resolves: staleClaim.event.id,
        summary: "try to revive stale overlapping write claim",
        staleAfterMs: 60_000,
      }),
      /heartbeat conflicts with active write claim/,
    );
  });
});

test("proposal events are visible until resolved and do not block closure", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const proposal = await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "worker-a",
      summary: "Add a reviewer lane",
      paths: ["src"],
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "vote",
      peerId: "worker-b",
      verdict: "pass",
      summary: "safe",
    });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.openProposals.length, 1);
    assert.match(formatPeerGoal(state), /Open proposals:/);
    assert.match(formatPeerGoalList({ goals: { [goalId]: proposal.goal } }), /1 proposal/);
    assert.equal(state.readyToClose, true);

    const closed = await closePeerGoal(root, goalId, { peerId: "tester", summary: "proposal is non-blocking" });
    assert.equal(closed.status, "closed");

    const secondRoot = await mkdtemp(join(tmpdir(), "pi-peer-goal-test-"));
    t.after(async () => {
      await rm(secondRoot, { recursive: true, force: true });
    });
    const secondGoal = await createPeerGoal(secondRoot, { objective: "resolve proposal", peerId: "tester" });
    const secondProposal = await appendPeerGoalEvent(secondRoot, secondGoal.id, {
      type: "proposal",
      peerId: "worker-a",
      summary: "Try this next",
    });
    const resolved = await appendPeerGoalEvent(secondRoot, secondGoal.id, {
      type: "resolve",
      peerId: "worker-b",
      resolves: secondProposal.event.id,
      summary: "Obsolete",
    });
    state = deriveGoalState(resolved.goal);
    assert.equal(state.proposals.length, 1);
    assert.equal(state.openProposals.length, 0);
  });
});

test("empty proposal summaries reject", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "proposal",
        peerId: "worker-a",
        summary: "   ",
      }),
      /proposal requires a summary/,
    );
  });
});

test("scout suggestions are read-only and prioritize proactive next steps", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const board = { goals: { [goalId]: { id: goalId, objective: "test goal", status: "open", events: [] } } };
    const before = JSON.stringify(board);
    const suggestions = derivePeerGoalScoutSuggestions(board);
    assert.equal(JSON.stringify(board), before);
    assert.equal(suggestions[0].kind, "next-step");
    assert.equal(suggestions[0].recommendedLane, "research");
    assert.deepEqual(suggestions[0].preferredRoles, ["researcher", "reviewer", "planner", "coordinator", "worker"]);
    assert.equal(suggestions[0].claimMode, "read");
    assert.match(formatPeerGoalScout(board), /lane: research for researcher\/reviewer\/planner\/coordinator\/worker \(read\)/);

    await appendPeerGoalEvent(root, goalId, {
      type: "objection",
      peerId: "worker-a",
      summary: "Need tests",
      severity: "blocking",
    });
    const withBlocker = await loadPeerGoalBoard(root);
    const blockerSuggestion = derivePeerGoalScoutSuggestions(withBlocker)[0];
    assert.equal(blockerSuggestion.kind, "blocker");
    assert.equal(blockerSuggestion.recommendedLane, "coordination");
    assert.deepEqual(blockerSuggestion.preferredRoles, ["planner", "coordinator", "reviewer"]);
  });
});

test("scout excludes closed goals unless requested", async (t) => {
  await withGoal(t, async (_root, goalId) => {
    const board = { goals: { [goalId]: { id: goalId, objective: "closed", status: "closed", events: [] } } };
    assert.equal(derivePeerGoalScoutSuggestions(board).length, 0);
    assert.equal(derivePeerGoalScoutSuggestions(board, { includeClosed: true }).length, 1);
  });
});
