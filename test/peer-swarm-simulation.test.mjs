import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { derivePeerIdleActivation } from "../src/peers/idle-watcher.mjs";
import {
  appendPeerGoalEvent,
  closePeerGoal,
  createPeerGoal,
  deriveGoalState,
  derivePeerGoalScoutSuggestions,
  loadPeerGoalBoard,
} from "../src/peers/goal-board.mjs";

async function withGoal(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-swarm-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const goal = await createPeerGoal(root, {
    objective: "deterministic swarm simulation",
    constraints: ["no duplicate work keys", "closure waits for handoffs"],
    peerId: "planner",
  });
  return fn(root, goal.id);
}

function event(id, type, input = {}) {
  return {
    id: `evt_${id}`,
    type,
    at: `2026-05-21T12:${String(Math.floor(id / 60)).padStart(2, "0")}:${String(id % 60).padStart(2, "0")}.000Z`,
    peerId: input.peerId || "planner",
    summary: input.summary || `${type} ${id}`,
    ...input,
  };
}

function fakePeer(index) {
  return {
    id: index % 3 === 0 ? `researcher-${index}` : index % 3 === 1 ? `reviewer-${index}` : `worker-${index}`,
    lane: index % 3 === 0 ? "research" : index % 3 === 1 ? "review" : "implementation",
  };
}

test("deterministic swarm simulation covers 3-10 peers, 120 iterations, proposals, handoffs, fairness, and closure gates", () => {
  for (let swarmSize = 3; swarmSize <= 10; swarmSize += 1) {
    const fakePeers = Array.from({ length: swarmSize }, (_, index) => fakePeer(index));
    const contributionCounts = new Map(fakePeers.map((peer) => [peer.id, 0]));
    const goal = {
      id: `goal_swarm_${swarmSize}`,
      objective: `large epic swarm simulation with ${swarmSize} peers`,
      status: "open",
      events: [],
    };
    let nextEventId = 1;

    for (let iteration = 0; iteration < 120; iteration += 1) {
      const peer = fakePeers[iteration % fakePeers.length];
      const workKey = `swarm:${swarmSize}:${iteration}:${peer.lane}`;
      const proposal = event(nextEventId++, "proposal", {
        peerId: "planner",
        summary: `work item ${iteration} for ${peer.lane}`,
        lane: peer.lane,
        workKey,
        paths: ["test/peer-swarm-simulation.test.mjs"],
      });
      goal.events.push(proposal);

      let suggestions = derivePeerGoalScoutSuggestions({ goals: { [goal.id]: goal } });
      const suggestion = suggestions.find((item) => item.kind === "open-proposal" && item.workKey === workKey);
      assert.ok(suggestion, `swarm ${swarmSize} iteration ${iteration} should expose proposed work key`);
      assert.equal(suggestion.recommendedLane, peer.lane);

      const claim = event(nextEventId++, "claim", {
        peerId: peer.id,
        summary: suggestion.summary,
        mode: "read",
        lane: peer.lane,
        workKey,
        staleAfterMs: 100 * 365 * 24 * 60 * 60 * 1000,
      });
      goal.events.push(claim);
      contributionCounts.set(peer.id, contributionCounts.get(peer.id) + 1);

      suggestions = derivePeerGoalScoutSuggestions({ goals: { [goal.id]: goal } });
      assert.equal(suggestions.some((item) => item.workKey === workKey && item.summary.startsWith("Self-select")), false, `swarm ${swarmSize} iteration ${iteration} should suppress duplicate active work`);

      goal.events.push(event(nextEventId++, "finding", {
        peerId: peer.id,
        summary: `completed deterministic work item ${iteration}`,
        lane: peer.lane,
        workKey,
      }));
      goal.events.push(event(nextEventId++, "release", {
        peerId: peer.id,
        resolves: claim.id,
        summary: `released ${workKey}`,
      }));

      suggestions = derivePeerGoalScoutSuggestions({ goals: { [goal.id]: goal } });
      assert.ok(suggestions.some((item) => item.relatedEventId === proposal.id && item.summary.startsWith("Resolve fulfilled")), `swarm ${swarmSize} iteration ${iteration} should require proposal resolution`);
      goal.events.push(event(nextEventId++, "resolve", {
        peerId: "coordinator",
        resolves: proposal.id,
        summary: `resolved ${workKey}`,
        lane: peer.lane,
        workKey,
      }));
    }

    const counts = [...contributionCounts.values()];
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `swarm ${swarmSize} should distribute work nearly equally`);

    let state = deriveGoalState(goal);
    assert.equal(state.openProposals.length, 0);
    assert.equal(state.activeClaims.length, 0);
    assert.equal(state.readyToClose, false, "closure still requires a passing vote");

    const lateProposal = event(nextEventId++, "proposal", {
      peerId: "reviewer-late",
      summary: "Late unresolved follow-up must block closure",
      lane: "review",
      workKey: `swarm:${swarmSize}:late-review`,
    });
    goal.events.push(lateProposal);
    goal.events.push(event(nextEventId++, "vote", {
      peerId: "reviewer-final",
      verdict: "pass",
      confidence: 0.9,
      summary: "120 deterministic swarm iterations completed",
    }));
    state = deriveGoalState(goal);
    assert.equal(state.passingVotes.length, 1);
    assert.equal(state.openProposals.length, 1);
    assert.equal(state.readyToClose, false, "open proposals must block false-positive closure even with a pass vote");

    goal.events.push(event(nextEventId++, "resolve", {
      peerId: "coordinator",
      resolves: lateProposal.id,
      summary: "late follow-up folded into backlog",
    }));
    state = deriveGoalState(goal);
    assert.equal(state.openProposals.length, 0);
    assert.equal(state.readyToClose, true);
  }
});

test("swarm simulation asserts duplicate work-key claims are rejected and stale work prioritizes cleanup", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "planner",
      summary: "Implement duplicate suppression",
      lane: "implementation",
      workKey: "swarm:duplicate",
      paths: ["src/peers/goal-board.mjs"],
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: "Claim duplicate-sensitive work",
      mode: "read",
      lane: "implementation",
      workKey: "swarm:duplicate",
      staleAfterMs: 60_000,
    });

    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "claim",
        peerId: "worker-b",
        summary: "Attempt duplicate work",
        mode: "read",
        lane: "implementation",
        workKey: "swarm:duplicate",
      }),
      /claim duplicates active work key swarm:duplicate/,
    );
  });

  const staleBoard = {
    goals: {
      goal_stale: {
        id: "goal_stale",
        objective: "stale cleanup without wall-clock timing",
        status: "open",
        events: [event(1, "claim", {
          at: "2020-01-01T00:00:00.000Z",
          peerId: "worker-stale",
          summary: "Stale coordination claim",
          mode: "read",
          lane: "coordination",
          workKey: "swarm:stale-cleanup",
          paths: ["src/peers/goal-board.mjs"],
          staleAfterMs: 1,
        })],
      },
    },
  };
  const suggestions = derivePeerGoalScoutSuggestions(staleBoard);
  assert.equal(suggestions[0].kind, "stale-claim");
  assert.equal(suggestions.some((item) => item.kind === "next-step"), false);
});

test("swarm simulation covers startup-lane fairness and closure blocking on active tasks", async (t) => {
  const board = {
    goals: {
      goal_startup: {
        id: "goal_startup",
        objective: "new large epic",
        status: "open",
        events: [],
      },
    },
  };

  assert.equal(derivePeerIdleActivation(board, { localPeerId: "researcher-1", nowMs: 1_000 }).recommendedLane, "research");
  assert.equal(derivePeerIdleActivation(board, { localPeerId: "reviewer-1", nowMs: 1_000 }).recommendedLane, "review");
  assert.equal(derivePeerIdleActivation(board, { localPeerId: "worker-1", nowMs: 1_000 }).recommendedLane, "implementation");

  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "task",
      peerId: "planner",
      summary: "Long-running fake peer task",
      taskId: "msg_swarm_task",
      status: "running",
      workKey: "swarm:handoff-gate",
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "vote",
      peerId: "reviewer",
      verdict: "pass",
      summary: "Looks good after task finishes",
    });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.activeTasks.length, 1);
    assert.equal(state.readyToClose, false);
    await assert.rejects(
      closePeerGoal(root, goalId, { peerId: "coordinator", summary: "premature close" }),
      /has active tasks/,
    );

    await appendPeerGoalEvent(root, goalId, {
      type: "handoff",
      peerId: "worker",
      summary: "Status: done; Files changed: none; Verification: simulated handoff; Blockers/risks: none; Safe for review: yes",
      taskId: "msg_swarm_task",
      status: "done",
      workKey: "swarm:handoff-gate",
    });
    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.activeTasks.length, 0);
    assert.equal(state.readyToClose, true);
  });
});
