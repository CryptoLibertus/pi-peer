import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { appendPeerGoalEvent, beginPeerGoalTask, closePeerGoal, completePeerGoalTask, createPeerGoal, deriveGoalState, derivePeerGoalScoutSuggestions, derivePeerGoalWorkKey, formatPeerGoal, formatPeerGoalList, formatPeerGoalScout, loadPeerGoalBoard, recordPeerGoalTaskDispatch } from "../src/peers/goal-board.mjs";

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
    const scoutText = formatPeerGoalScout(board);
    assert.match(scoutText, /lane: research for researcher\/planner\/coordinator \(read\)/);
    assert.match(scoutText, /lane: implementation for worker \(read\)/);
    assert.match(scoutText, /key: .*research/);
    assert.match(scoutText, /claim: \/peer goal claim/);
    assert.match(scoutText, /--key/);

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
      workKey: "epic:implementation:cli-parsing",
    });

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    const laneSuggestion = suggestions.find((suggestion) => suggestion.summary.includes("Self-select proposed implementation lane"));
    assert.ok(laneSuggestion);
    assert.equal(laneSuggestion.kind, "open-proposal");
    assert.equal(laneSuggestion.recommendedLane, "implementation");
    assert.deepEqual(laneSuggestion.preferredRoles, ["worker"]);
    assert.equal(laneSuggestion.claimMode, "read");
    assert.equal(laneSuggestion.workKey, "epic:implementation:cli-parsing");
    assert.match(formatPeerGoalScout(await loadPeerGoalBoard(root)), /claim: \/peer goal claim .*--key epic:implementation:cli-parsing/);

    const implicitRoot = await mkdtemp(join(tmpdir(), "pi-peer-goal-test-"));
    t.after(async () => {
      await rm(implicitRoot, { recursive: true, force: true });
    });
    const implicitGoal = await createPeerGoal(implicitRoot, { objective: "implicit key", peerId: "tester" });
    await appendPeerGoalEvent(implicitRoot, implicitGoal.id, {
      type: "proposal",
      peerId: "planner-a",
      summary: "Review package contents",
      lane: "review",
      paths: ["package.json"],
    });
    const implicitSuggestion = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(implicitRoot)).find((suggestion) => suggestion.recommendedLane === "review");
    assert.equal(implicitSuggestion.workKey, derivePeerGoalWorkKey({ goalId: implicitGoal.id, lane: "review", objective: "Review package contents", mode: "read", paths: ["package.json"] }));
    assert.doesNotMatch(implicitSuggestion.workKey, /self-select proposed/);

    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: laneSuggestion.summary,
      mode: "read",
      lane: laneSuggestion.recommendedLane,
      workKey: laneSuggestion.workKey,
    });
    const claimedSuggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(claimedSuggestions.some((suggestion) => suggestion.workKey === laneSuggestion.workKey), false);
  });
});

test("scout stops re-emitting completed proposal lane work but keeps triage visible", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const workKey = "fake-task:implementation:test-design";
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "planner",
      summary: "Design a self-organization regression test",
      lane: "implementation",
      paths: ["test/peer-goal-board.test.mjs"],
      workKey,
    });
    const claim = await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: "Self-select proposed implementation lane",
      mode: "read",
      lane: "implementation",
      paths: ["test/peer-goal-board.test.mjs"],
      workKey,
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "finding",
      peerId: "worker-a",
      summary: "Regression test design posted",
      lane: "implementation",
      paths: ["test/peer-goal-board.test.mjs"],
      workKey,
    });
    await appendPeerGoalEvent(root, goalId, { type: "release", peerId: "worker-a", resolves: claim.event.id, summary: "lane complete" });

    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.openProposals.length, 1);
    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(suggestions.some((suggestion) => suggestion.workKey === workKey && suggestion.summary.startsWith("Self-select proposed implementation lane")), false);
    const resolveSuggestion = suggestions.find((suggestion) => suggestion.summary.startsWith("Resolve fulfilled implementation proposal"));
    assert.ok(resolveSuggestion);
    assert.equal(resolveSuggestion.recommendedLane, "coordination");
    assert.equal(resolveSuggestion.relatedEventId, state.openProposals[0].id);
    assert.equal(suggestions.some((suggestion) => suggestion.kind === "open-proposal" && suggestion.summary.startsWith("Triage 1 open proposal")), true);

    const implicitRoot = await mkdtemp(join(tmpdir(), "pi-peer-goal-test-"));
    t.after(async () => {
      await rm(implicitRoot, { recursive: true, force: true });
    });
    const implicitGoal = await createPeerGoal(implicitRoot, { objective: "implicit completed proposal", peerId: "tester" });
    const implicitSummary = "Design an implicit-key regression test";
    const implicitKey = derivePeerGoalWorkKey({ goalId: implicitGoal.id, lane: "implementation", objective: implicitSummary, mode: "read", paths: ["test/peer-goal-board.test.mjs"] });
    await appendPeerGoalEvent(implicitRoot, implicitGoal.id, {
      type: "proposal",
      peerId: "planner",
      summary: implicitSummary,
      lane: "implementation",
      paths: ["test/peer-goal-board.test.mjs"],
    });
    const implicitClaim = await appendPeerGoalEvent(implicitRoot, implicitGoal.id, {
      type: "claim",
      peerId: "worker-a",
      summary: "Self-select implicit proposed implementation lane",
      mode: "read",
      lane: "implementation",
      paths: ["test/peer-goal-board.test.mjs"],
      workKey: implicitKey,
    });
    await appendPeerGoalEvent(implicitRoot, implicitGoal.id, { type: "finding", peerId: "worker-a", summary: "Implicit-key work completed", lane: "implementation", workKey: implicitKey });
    await appendPeerGoalEvent(implicitRoot, implicitGoal.id, { type: "release", peerId: "worker-a", resolves: implicitClaim.event.id, summary: "implicit lane complete" });
    const implicitSuggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(implicitRoot));
    assert.equal(implicitSuggestions.some((suggestion) => suggestion.workKey === implicitKey && suggestion.summary.startsWith("Self-select proposed implementation lane")), false);
    assert.equal(implicitSuggestions.some((suggestion) => suggestion.summary.startsWith("Resolve fulfilled implementation proposal")), true);
  });
});

test("proposal triage distinguishes total open proposals from actionable unclaimed work", async (t) => {
  await withGoal(t, async (root, goalId) => {
    for (let index = 1; index <= 5; index += 1) {
      await appendPeerGoalEvent(root, goalId, {
        type: "proposal",
        peerId: "planner",
        summary: `Loop ${index} work`,
        lane: "review",
        workKey: `loop-${index}`,
      });
    }
    for (const workKey of ["loop-1", "loop-2"]) {
      await appendPeerGoalEvent(root, goalId, {
        type: "claim",
        peerId: `worker-${workKey}`,
        summary: `Claim ${workKey}`,
        mode: "read",
        lane: "review",
        workKey,
      });
    }

    let suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    const triage = suggestions.find((suggestion) => suggestion.summary.startsWith("Triage 5 open proposals"));
    assert.ok(triage);
    assert.match(triage.summary, /3 unclaimed actionable/);
    assert.match(triage.summary, /2 active-owned/);
    assert.equal(triage.workKey, derivePeerGoalWorkKey({ goalId, lane: "coordination", objective: "triage open proposals", mode: "read" }));
    assert.equal(suggestions.filter((suggestion) => suggestion.summary.startsWith("Self-select proposed review lane")).length, 3);

    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "coordinator",
      summary: triage.summary,
      mode: "read",
      lane: "coordination",
      workKey: triage.workKey,
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-loop-3",
      summary: "Claim loop-3 after triage started",
      mode: "read",
      lane: "review",
      workKey: "loop-3",
    });
    suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(suggestions.some((suggestion) => suggestion.summary.startsWith("Triage")), false);
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

test("completed goal-linked tasks do not keep showing as running", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const link = await beginPeerGoalTask(root, goalId, {
      targetPeerId: "worker-a",
      prompt: "Review finalization",
      mode: "read",
      lane: "review",
      duplicatePolicy: "reuse",
    });
    const task = await recordPeerGoalTaskDispatch(root, goalId, {
      requesterPeerId: "planner",
      targetPeerId: "worker-a",
      prompt: "Review finalization",
      mode: "read",
      lane: "review",
      workKey: link.workKey,
      messageId: "msg_review",
      conversationId: "conv_review",
      claimEventId: link.claimEvent.id,
    });
    await completePeerGoalTask(root, goalId, {
      targetPeerId: "worker-a",
      messageId: "msg_review",
      conversationId: "conv_review",
      claimEventId: link.claimEvent.id,
      workKey: link.workKey,
      status: "done",
      responseStatus: "OK",
    });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].status, "done");
    assert.equal(state.tasks[0].handoffEventId.startsWith("evt_handoff_"), true);
    assert.ok(state.tasks[0].completedAt);
    assert.equal(state.activeClaims.length, 0);

    const planned = await appendPeerGoalEvent(root, goalId, {
      type: "task",
      peerId: "planner",
      summary: "planned fanout task",
      taskId: "planned-task-id",
      status: "running",
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "handoff",
      peerId: "worker-b",
      summary: "fanout task completed by event id",
      taskId: planned.event.id,
      status: "done",
    });
    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.tasks.find((item) => item.id === planned.event.id).status, "done");
  });
});

test("task projection does not complete sibling tasks that share a work key", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const workKey = "shared-review-key";
    await appendPeerGoalEvent(root, goalId, {
      type: "task",
      peerId: "planner",
      summary: "first review attempt",
      taskId: "msg_one",
      status: "running",
      workKey,
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "task",
      peerId: "planner",
      summary: "second review attempt",
      taskId: "msg_two",
      status: "running",
      workKey,
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "handoff",
      peerId: "reviewer-one",
      summary: "first review done",
      taskId: "msg_one",
      status: "done",
      workKey,
    });

    const tasks = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]).tasks;
    assert.equal(tasks.find((task) => task.taskId === "msg_one").status, "done");
    assert.equal(tasks.find((task) => task.taskId === "msg_two").status, "running");
  });
});

test("large epic self-organization flow resolves lanes, gates closure, and closes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-epic-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const goal = await createPeerGoal(root, {
    objective: "large epic: ship autonomous multi-peer planning",
    constraints: ["no duplicate lanes", "closure requires vote"],
    peerId: "planner",
  });
  const goalId = goal.id;

  const laneProposals = [
    ["research", "Map risks and alternatives"],
    ["review", "Validate coordination behavior"],
    ["implementation", "Plan source changes"],
    ["coordination", "Close readiness gates"],
  ];
  for (const [lane, summary] of laneProposals) {
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "planner",
      summary,
      lane,
      workKey: `epic:${lane}`,
    });
  }

  let suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
  for (const [lane] of laneProposals) {
    const suggestion = suggestions.find((item) => item.recommendedLane === lane && item.kind === "open-proposal");
    assert.ok(suggestion, `missing ${lane} suggestion`);
    assert.equal(suggestion.workKey, `epic:${lane}`);
  }
  const scoutText = formatPeerGoalScout(await loadPeerGoalBoard(root));
  assert.match(scoutText, /key: epic:research/);
  assert.match(scoutText, /claim: \/peer goal claim .*--key epic:review/);

  const research = suggestions.find((item) => item.workKey === "epic:research");
  const researchClaim = await appendPeerGoalEvent(root, goalId, {
    type: "claim",
    peerId: "researcher",
    summary: research.summary,
    mode: "read",
    lane: "research",
    workKey: research.workKey,
  });
  suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
  assert.equal(suggestions.some((item) => item.workKey === "epic:research"), false);
  await appendPeerGoalEvent(root, goalId, { type: "finding", peerId: "researcher", summary: "Use exact proposal work keys for lane claims.", lane: "research", workKey: "epic:research" });
  await appendPeerGoalEvent(root, goalId, { type: "release", peerId: "researcher", resolves: researchClaim.event.id, summary: "research done" });

  const stateAfterResearch = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
  const actualResearchProposal = stateAfterResearch.openProposals.find((proposal) => proposal.workKey === "epic:research");
  await appendPeerGoalEvent(root, goalId, { type: "resolve", peerId: "researcher", resolves: actualResearchProposal.id, summary: "research proposal fulfilled", lane: "research", workKey: "epic:research" });

  const implLink = await beginPeerGoalTask(root, goalId, {
    targetPeerId: "worker",
    prompt: "Plan source changes",
    mode: "read",
    lane: "implementation",
    workKey: "epic:implementation",
    duplicatePolicy: "reuse",
  });
  assert.equal(implLink.claimEvent.workKey, "epic:implementation");
  const duplicateImpl = await beginPeerGoalTask(root, goalId, {
    targetPeerId: "worker-2",
    prompt: "Plan source changes",
    mode: "read",
    lane: "implementation",
    workKey: "epic:implementation",
    duplicatePolicy: "reuse",
  });
  assert.equal(duplicateImpl.duplicate, true);
  await recordPeerGoalTaskDispatch(root, goalId, { requesterPeerId: "planner", targetPeerId: "worker", prompt: "Plan source changes", mode: "read", lane: "implementation", workKey: "epic:implementation", messageId: "msg_impl", claimEventId: implLink.claimEvent.id });
  await completePeerGoalTask(root, goalId, { targetPeerId: "worker", messageId: "msg_impl", claimEventId: implLink.claimEvent.id, workKey: "epic:implementation", status: "done" });

  let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
  assert.equal(state.tasks.find((task) => task.taskId === "msg_impl").status, "done");

  const writeClaim = await appendPeerGoalEvent(root, goalId, {
    type: "claim",
    peerId: "worker",
    summary: "Reserve implementation files",
    mode: "write",
    paths: ["src/peers/goal-board.mjs"],
    workKey: "epic:implementation-write",
  });
  await assert.rejects(
    appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-2",
      summary: "Overlapping implementation files",
      mode: "write",
      paths: ["src/peers/goal-board.mjs"],
      workKey: "epic:implementation-write-2",
    }),
    /claim conflicts with active write claim/,
  );
  await appendPeerGoalEvent(root, goalId, { type: "release", peerId: "worker", resolves: writeClaim.event.id, summary: "implementation file plan complete" });

  const remainingProposals = new Map(deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]).openProposals.map((proposal) => [proposal.workKey, proposal.id]));
  for (const key of ["epic:review", "epic:implementation", "epic:coordination"]) {
    await appendPeerGoalEvent(root, goalId, { type: "resolve", peerId: "planner", resolves: remainingProposals.get(key), summary: `${key} lane fulfilled`, workKey: key });
  }

  const blocker = await appendPeerGoalEvent(root, goalId, { type: "objection", peerId: "reviewer", summary: "Need final vote", severity: "blocking" });
  await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "reviewer", verdict: "fail", confidence: 0.7, summary: "Not ready until final blocker resolved" });
  await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "reviewer", verdict: "pass-with-risks", confidence: 0.86, summary: "Large epic flow passed with work-key ergonomics risk" });
  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
  assert.equal(state.readyToClose, false);
  assert.equal(state.blockingObjections.length, 1);
  assert.equal(state.failedVotes.length, 0);
  assert.equal(state.passingVotes.length, 1);

  await appendPeerGoalEvent(root, goalId, { type: "resolve", peerId: "coordinator", resolves: blocker.event.id, summary: "final vote recorded" });
  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
  assert.equal(state.openProposals.length, 0);
  assert.equal(state.blockingObjections.length, 0);
  assert.equal(state.passingVotes.length, 1);
  assert.equal(state.readyToClose, true);

  const closed = await closePeerGoal(root, goalId, { peerId: "coordinator", summary: "large epic gates satisfied" });
  assert.equal(closed.status, "closed");
  assert.equal(derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root)).length, 0);
});
