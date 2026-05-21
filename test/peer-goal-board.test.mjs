import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { appendPeerGoalEvent, beginPeerGoalTask, closePeerGoal, createPeerGoal, deriveGoalState, derivePeerGoalScoutSuggestions, derivePeerGoalWorkKey, formatPeerGoal, formatPeerGoalList, formatPeerGoalScout, loadPeerGoalBoard, recordPeerGoalTaskDispatch } from "../src/peers/goal-board.mjs";

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
    assert.deepEqual(suggestions[0].preferredRoles, ["researcher", "planner", "coordinator"]);
    assert.equal(suggestions[0].claimMode, "read");
    assert.equal(suggestions[1].recommendedLane, "review");
    assert.equal(suggestions[2].recommendedLane, "implementation");
    assert.equal(new Set(suggestions.slice(0, 3).map((suggestion) => suggestion.workKey)).size, 3);
    assert.match(formatPeerGoalScout(board), /lane: research for researcher\/planner\/coordinator \(read\)/);
    assert.match(formatPeerGoalScout(board), /lane: implementation for worker \(read\)/);

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

test("scout suggestions turn lane proposals into self-selection work", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "planner-a",
      summary: "Add an implementation lane for CLI parsing",
      lane: "implementation",
      paths: ["src/peers/command.mjs"],
    });

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    const laneSuggestion = suggestions.find((suggestion) => suggestion.summary.includes("Self-select proposed implementation lane"));
    assert.ok(laneSuggestion);
    assert.equal(laneSuggestion.kind, "open-proposal");
    assert.equal(laneSuggestion.recommendedLane, "implementation");
    assert.deepEqual(laneSuggestion.preferredRoles, ["worker"]);
    assert.equal(laneSuggestion.claimMode, "read");
    assert.match(laneSuggestion.workKey, /implementation/);
  });
});

test("semantic work keys prevent duplicate read claims unless explicitly parallel", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const workKey = derivePeerGoalWorkKey({ goalId, lane: "review", objective: "Check finalization safety", mode: "read", paths: ["src"] });
    const first = await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "reviewer-a",
      summary: "Check finalization safety",
      mode: "read",
      paths: ["src"],
      workKey,
    });
    assert.equal(first.event.workKey, workKey);

    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "claim",
        peerId: "reviewer-b",
        summary: "Check finalization safety too",
        mode: "read",
        paths: ["src"],
        workKey,
      }),
      /duplicates active work key/,
    );

    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "reviewer-c",
      summary: "Independent second opinion",
      mode: "read",
      paths: ["src"],
      workKey,
      duplicatePolicy: "allow-parallel",
    });

    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.activeClaims.length, 2);
  });
});

test("heartbeats cannot revive stale semantic claims over an active matching work key", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const workKey = derivePeerGoalWorkKey({ goalId, lane: "review", objective: "Review duplicate prevention", mode: "read" });
    const staleClaim = await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "reviewer-a",
      summary: "Review duplicate prevention",
      mode: "read",
      lane: "review",
      workKey,
      staleAfterMs: 1,
    });

    await delay(5);

    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "reviewer-b",
      summary: "Review duplicate prevention after stale",
      mode: "read",
      lane: "review",
      workKey,
    });

    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "heartbeat",
        peerId: "reviewer-a",
        resolves: staleClaim.event.id,
        summary: "try to revive stale duplicate review claim",
        staleAfterMs: 60_000,
      }),
      /heartbeat conflicts with active work key/,
    );
  });
});

test("beginPeerGoalTask reuses active work instead of creating duplicate dispatch", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const first = await beginPeerGoalTask(root, goalId, {
      targetPeerId: "reviewer-a",
      prompt: "Review duplicate prevention",
      mode: "read",
      lane: "review",
      claimedPaths: ["src/peers/goal-board.mjs"],
      duplicatePolicy: "reuse",
    });
    await recordPeerGoalTaskDispatch(root, goalId, {
      requesterPeerId: "planner",
      targetPeerId: "reviewer-a",
      prompt: "Review duplicate prevention",
      mode: "read",
      lane: "review",
      claimedPaths: ["src/peers/goal-board.mjs"],
      workKey: first.workKey,
      messageId: "msg_existing",
      conversationId: "conv_existing",
      claimEventId: first.claimEvent.id,
    });

    const second = await beginPeerGoalTask(root, goalId, {
      targetPeerId: "reviewer-b",
      prompt: "Review duplicate prevention",
      mode: "read",
      lane: "review",
      claimedPaths: ["src/peers/goal-board.mjs"],
      duplicatePolicy: "reuse",
    });

    assert.equal(second.duplicate, true);
    assert.equal(second.workKey, first.workKey);
    assert.equal(second.existingClaim.id, first.claimEvent.id);
    assert.equal(second.existingTask.taskId, "msg_existing");
    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.activeClaims.length, 1);
  });
});

test("scout suppresses suggestions whose work key is actively claimed", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const summary = "No active work yet; propose a research, review, or implementation lane.";
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "researcher-a",
      summary,
      mode: "read",
      lane: "research",
      workKey: derivePeerGoalWorkKey({ goalId, lane: "research", objective: summary, mode: "read" }),
    });

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(suggestions.some((suggestion) => suggestion.kind === "next-step"), false);
  });
});

test("scout excludes closed goals unless requested", async (t) => {
  await withGoal(t, async (_root, goalId) => {
    const board = { goals: { [goalId]: { id: goalId, objective: "closed", status: "closed", events: [] } } };
    assert.equal(derivePeerGoalScoutSuggestions(board).length, 0);
    assert.equal(derivePeerGoalScoutSuggestions(board, { includeClosed: true }).length, 3);
  });
});
