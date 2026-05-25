import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { appendPeerGoalEvent, beginPeerGoalTask, closePeerGoal, completePeerGoalTask, createPeerGoal, deriveGoalState, derivePeerGoalScoutSuggestions, derivePeerGoalWorkKey, formatPeerGoal, formatPeerGoalList, formatPeerGoalScout, loadPeerGoalBoard, projectSubagentEvidence, recordPeerGoalTaskDispatch, validateGoalReadyToClose } from "../src/peers/goal-board.mjs";
import { appendGoalJournalRecord, compactGoalJournal, goalJournalPath, replayGoalJournal } from "../src/peers/goal-store.mjs";
import { parsePeerCommand } from "../src/peers/command.mjs";

async function withGoal(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const goal = await createPeerGoal(root, { objective: "test goal", peerId: "tester" });
  return fn(root, goal.id);
}

test("goal-store journal replays event records equivalent to current board semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-store-source-"));
  const journalRoot = await mkdtemp(join(tmpdir(), "pi-peer-goal-store-journal-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  });

  const goal = await createPeerGoal(root, { objective: "journal equivalence", peerId: "tester" });
  const baseBoard = await loadPeerGoalBoard(root);
  const claim = await appendPeerGoalEvent(root, goal.id, {
    type: "claim",
    peerId: "worker-a",
    summary: "append-only replay claim",
    mode: "read",
    lane: "review",
    workKey: "goal-store:replay",
  });
  const canonical = await loadPeerGoalBoard(root);

  await appendGoalJournalRecord(journalRoot, { type: "snapshot", board: baseBoard });
  await appendGoalJournalRecord(journalRoot, { type: "event", goalId: goal.id, event: claim.event });
  const replayed = await replayGoalJournal(journalRoot);

  assert.deepEqual(replayed.board, canonical);
  assert.deepEqual(replayed.warnings, []);
});

test("live goal-board mutations append replayable journal snapshots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-live-journal-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const goal = await createPeerGoal(root, { objective: "live journal", peerId: "tester" });
  await appendPeerGoalEvent(root, goal.id, {
    type: "finding",
    peerId: "reviewer",
    lane: "review",
    summary: "live journal captured this event",
  });

  const canonical = await loadPeerGoalBoard(root);
  const replayed = await replayGoalJournal(root);

  assert.deepEqual(replayed.board, canonical);
  assert.deepEqual(replayed.warnings, []);
});

test("loadPeerGoalBoard recovers a corrupt snapshot from the live journal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-journal-recover-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const goal = await createPeerGoal(root, { objective: "recover from journal", peerId: "tester" });
  await appendPeerGoalEvent(root, goal.id, {
    type: "finding",
    peerId: "reviewer",
    lane: "review",
    summary: "recoverable evidence",
  });
  const canonical = await replayGoalJournal(root);
  await writeFile(join(root, ".pi/peer-goals.json"), "{not json", "utf8");

  const recovered = await loadPeerGoalBoard(root);

  assert.deepEqual(recovered, canonical.board);
});

test("goal-store compaction preserves migration-compatible snapshot semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-store-compact-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const goal = await createPeerGoal(root, { objective: "compact journal", peerId: "tester" });
  await appendPeerGoalEvent(root, goal.id, {
    type: "proposal",
    peerId: "planner",
    summary: "compact this board",
    lane: "implementation",
    workKey: "goal-store:compact",
  });
  const canonical = await loadPeerGoalBoard(root);

  await compactGoalJournal(root, canonical);
  const replayed = await replayGoalJournal(root);

  assert.deepEqual(replayed.board, canonical);
  assert.deepEqual(replayed.warnings, []);
});

test("goal-store replay ignores corrupt trailing journal record but surfaces middle corruption", async (t) => {
  const trailingRoot = await mkdtemp(join(tmpdir(), "pi-peer-goal-store-trailing-"));
  const middleRoot = await mkdtemp(join(tmpdir(), "pi-peer-goal-store-middle-"));
  t.after(async () => {
    await rm(trailingRoot, { recursive: true, force: true });
    await rm(middleRoot, { recursive: true, force: true });
  });

  const snapshot = { goals: { goal_a: { id: "goal_a", objective: "safe snapshot", status: "open", events: [] } }, currentGoalId: "goal_a" };
  const validLine = `${JSON.stringify({ type: "snapshot", board: snapshot })}\n`;

  await mkdir(dirname(goalJournalPath(trailingRoot)), { recursive: true });
  await writeFile(goalJournalPath(trailingRoot), `${validLine}{"type":"event"`, "utf8");
  const replayed = await replayGoalJournal(trailingRoot);
  assert.deepEqual(replayed.board, snapshot);
  assert.equal(replayed.warnings[0].type, "trailing-corrupt-record");

  await mkdir(dirname(goalJournalPath(middleRoot)), { recursive: true });
  await writeFile(goalJournalPath(middleRoot), `${validLine}{"type":"event"\n${validLine}`, "utf8");
  await assert.rejects(
    replayGoalJournal(middleRoot),
    /corrupt peer goal journal record at line 2/,
  );
});

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

test("write claim paths canonicalize dot segments and reject escapes", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: "claim readme",
      mode: "write",
      paths: ["README.md"],
    });

    for (const samePath of ["src/../README.md", "src\\..\\README.md"]) {
      await assert.rejects(
        appendPeerGoalEvent(root, goalId, {
          type: "claim",
          peerId: "worker-b",
          summary: `claim same readme through ${samePath}`,
          mode: "write",
          paths: [samePath],
        }),
        /claim conflicts with active write claim/,
      );
    }
  });

  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: "claim normalized child",
      mode: "write",
      paths: ["a/b"],
    });

    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "claim",
        peerId: "worker-b",
        summary: "claim same child through current segment",
        mode: "write",
        paths: ["a/./b"],
      }),
      /claim conflicts with active write claim/,
    );
  });

  await withGoal(t, async (root, goalId) => {
    for (const invalidPath of ["../outside", "/tmp/file", "C:\\tmp\\file", "C:tmp\\file", "C:/../foo"]) {
      await assert.rejects(
        appendPeerGoalEvent(root, goalId, {
          type: "claim",
          peerId: "worker-a",
          summary: `claim invalid ${invalidPath}`,
          mode: "write",
          paths: [invalidPath],
        }),
        /write claim paths must be project-relative/,
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

test("proposal events are visible until resolved and block normal closure", async (t) => {
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
    assert.equal(state.readyToClose, false);
    await assert.rejects(
      closePeerGoal(root, goalId, { peerId: "tester", summary: "proposal must be resolved first" }),
      /unresolved open proposals/,
    );

    await appendPeerGoalEvent(root, goalId, { type: "resolve", peerId: "worker-b", resolves: proposal.event.id, summary: "Reviewer lane complete" });
    const closed = await closePeerGoal(root, goalId, { peerId: "tester", summary: "proposal resolved" });
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

test("active read claims and running tasks block normal closure", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const claim = await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "reviewer-a",
      summary: "Read-only review still in progress",
      mode: "read",
      lane: "review",
      workKey: "closure-review",
    });
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "planner", verdict: "pass", summary: "Looks good after review" });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.readyToClose, false);
    await assert.rejects(
      closePeerGoal(root, goalId, { peerId: "planner", summary: "should wait for read review" }),
      /has active claims/,
    );

    await appendPeerGoalEvent(root, goalId, { type: "release", peerId: "reviewer-a", resolves: claim.event.id, summary: "review finished" });
    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.readyToClose, true);
  });

  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "task",
      peerId: "planner",
      summary: "Reviewer fanout is still running",
      taskId: "msg_review",
      status: "running",
      workKey: "closure-task",
    });
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "planner", verdict: "pass", summary: "Looks good once fanout returns" });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.activeTasks.length, 1);
    assert.equal(state.readyToClose, false);
    await assert.rejects(
      closePeerGoal(root, goalId, { peerId: "planner", summary: "should wait for task handoff" }),
      /has active tasks/,
    );

    await appendPeerGoalEvent(root, goalId, {
      type: "handoff",
      peerId: "reviewer-a",
      summary: "Reviewer fanout complete",
      taskId: "msg_review",
      status: "done",
      workKey: "closure-task",
    });
    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.activeTasks.length, 0);
    assert.equal(state.readyToClose, true);
  });
});

test("stale claims block normal closure until released", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const claim = await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "reviewer-stale",
      summary: "Review claim that went stale",
      mode: "read",
      lane: "review",
      workKey: "closure-stale-review",
      staleAfterMs: 1,
    });
    await delay(5);
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "planner", verdict: "pass", summary: "Looks good after stale work is resolved" });

    let board = await loadPeerGoalBoard(root);
    let state = deriveGoalState(board.goals[goalId]);
    assert.equal(state.activeClaims.length, 0);
    assert.equal(state.staleClaims.length, 1);
    assert.equal(state.readyToClose, false);
    assert.throws(() => validateGoalReadyToClose(state), /has stale claims/);
    await assert.rejects(
      closePeerGoal(root, goalId, { peerId: "planner", summary: "should wait for stale claim cleanup" }),
      /has stale claims/,
    );

    let suggestions = derivePeerGoalScoutSuggestions(board, { goalId });
    assert.equal(suggestions.some((item) => item.kind === "stale-claim"), true);
    assert.equal(suggestions.some((item) => item.kind === "close"), false);

    await appendPeerGoalEvent(root, goalId, { type: "release", peerId: "reviewer-stale", resolves: claim.event.id, summary: "stale review explicitly released" });
    board = await loadPeerGoalBoard(root);
    state = deriveGoalState(board.goals[goalId]);
    assert.equal(state.staleClaims.length, 0);
    assert.equal(state.readyToClose, true);
    suggestions = derivePeerGoalScoutSuggestions(board, { goalId });
    assert.equal(suggestions.some((item) => item.kind === "close"), true);
  });
});

test("expired claims do not block normal closure", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "reviewer-expired",
      summary: "Time-boxed review claim expired",
      mode: "read",
      lane: "review",
      workKey: "closure-expired-review",
      ttlMs: 1,
      staleAfterMs: 60_000,
    });
    await delay(5);
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "planner", verdict: "pass", summary: "Expired claim intentionally timed out" });

    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.activeClaims.length, 0);
    assert.equal(state.staleClaims.length, 0);
    assert.equal(state.expiredClaims.length, 1);
    assert.equal(state.readyToClose, true);
    assert.doesNotThrow(() => validateGoalReadyToClose(state));
  });
});

test("closure policy defaults preserve one-pass vote compatibility", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "Default closure still only needs a passing vote when no work is open" });

    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.closurePolicy, undefined);
    assert.equal(state.closurePolicyStatus.satisfied, true);
    assert.equal(state.readyToClose, true);
    assert.doesNotThrow(() => validateGoalReadyToClose(state));
  });
});

test("closure policy can require lane and role specific votes and evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-policy-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "policy gated goal",
    peerId: "planner",
    closurePolicy: {
      minPassingVotes: 2,
      requiredVotes: [
        { lane: "review", min: 1 },
        { role: "qa", min: 1 },
      ],
      requiredEvidence: [
        { type: "finding", lane: "implementation", min: 1 },
        { type: "handoff", lane: "review", status: "done", min: 1 },
      ],
    },
  });

  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-a", verdict: "pass", lane: "review", summary: "review pass" });
  let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.readyToClose, false);
  assert.equal(state.closurePolicyStatus.satisfied, false);
  assert.match(state.closurePolicyStatus.missing.map((item) => item.summary).join("\n"), /2 passing votes required/);
  assert.match(state.closurePolicyStatus.missing.map((item) => item.summary).join("\n"), /role=qa/);
  assert.throws(() => validateGoalReadyToClose(state), /unmet closure policy requirements/);
  await assert.rejects(closePeerGoal(root, created.id, { peerId: "planner" }), /unmet closure policy requirements/);

  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "qa-a", verdict: "pass-with-risks", lane: "review", summary: "qa pass", metadata: { role: "qa" } });
  await appendPeerGoalEvent(root, created.id, { type: "finding", peerId: "worker-a", lane: "implementation", summary: "Implementation evidence present" });
  await appendPeerGoalEvent(root, created.id, { type: "handoff", peerId: "reviewer-a", lane: "review", status: "done", summary: "Review handoff complete" });

  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.closurePolicyStatus.satisfied, true);
  assert.equal(state.readyToClose, true);
  assert.doesNotThrow(() => validateGoalReadyToClose(state));
});

test("closure policy can require evidence from distinct peers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-distinct-policy-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "distinct evidence policy goal",
    peerId: "planner",
    closurePolicy: {
      minPassingVotes: 1,
      requiredEvidence: [{ type: "finding", lane: "review", min: 4, minDistinctPeers: 2 }],
    },
  });

  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "base vote" });
  await appendPeerGoalEvent(root, created.id, { type: "finding", peerId: "reviewer-a", lane: "review", summary: "first review finding" });
  await appendPeerGoalEvent(root, created.id, { type: "finding", peerId: "reviewer-a", lane: "review", summary: "same peer should not satisfy diversity" });

  let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.readyToClose, false);
  assert.match(state.closurePolicyStatus.missing.map((item) => item.summary).join("\n"), /distinctPeers>=2/);
  assert.match(state.closurePolicyStatus.missing.map((item) => item.summary).join("\n"), /2 matching event\(s\) from distinct peer\(s\) \(1 present\)/);

  await appendPeerGoalEvent(root, created.id, { type: "finding", peerId: "reviewer-b", lane: "review", summary: "independent review finding" });
  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.readyToClose, false);
  assert.match(state.closurePolicyStatus.missing.map((item) => item.summary).join("\n"), /4 matching event\(s\) \(3 present\)/);

  await appendPeerGoalEvent(root, created.id, { type: "finding", peerId: "reviewer-c", lane: "review", summary: "fourth review finding" });
  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.closurePolicyStatus.satisfied, true);
  assert.equal(state.readyToClose, true);
});

test("closure policy can require independent passing votes from non-producers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-independent-vote-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "independent review policy goal",
    peerId: "planner",
    closurePolicy: { minPassingVotes: 1, minIndependentVotes: 1 },
  });

  await appendPeerGoalEvent(root, created.id, {
    type: "claim",
    peerId: "worker-a",
    summary: "implement feature",
    mode: "write",
    lane: "implementation",
    paths: ["src/peers/goal-board.mjs"],
  });
  await appendPeerGoalEvent(root, created.id, { type: "release", peerId: "worker-a", resolves: (await loadPeerGoalBoard(root)).goals[created.id].events[0].id, summary: "implementation done" });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "worker-a", verdict: "pass", summary: "self-approved" });

  let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.passingVotes.length, 1);
  assert.equal(state.independentPassingVotes.length, 0);
  assert.equal(state.readyToClose, false);
  assert.match(state.closurePolicyStatus.missing.map((item) => item.summary).join("\n"), /1 independent passing vote\(s\) required \(0 present\)/);

  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "independent review pass" });
  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.independentPassingVotes.length, 1);
  assert.equal(state.readyToClose, true);
});

test("subagent evidence renders while child votes do not satisfy independent vote policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-subagent-evidence-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "subagent evidence gated goal",
    peerId: "planner",
    closurePolicy: { minIndependentVotes: 1 },
  });

  await completePeerGoalTask(root, created.id, {
    peerId: "worker-a",
    lane: "implementation",
    summary: "Implementation complete with private team evidence",
    subagentEvidence: {
      provider: "pi-subagents",
      childCount: 2,
      completedCount: 1,
      blockedCount: 1,
      artifactRefs: ["artifact:subrun-1"],
    },
  });
  await appendPeerGoalEvent(root, created.id, {
    type: "vote",
    peerId: "worker-a-child",
    verdict: "pass",
    summary: "child review pass",
    metadata: { subagent: true, parentPeerId: "worker-a", countsForIndependentVote: false },
  });

  let goal = (await loadPeerGoalBoard(root)).goals[created.id];
  let state = deriveGoalState(goal);
  assert.equal(state.passingVotes.length, 1);
  assert.equal(state.independentPassingVotes.length, 0);
  assert.equal(state.readyToClose, false);
  assert.match(state.closurePolicyStatus.missing.map((item) => item.summary).join("\n"), /1 independent passing vote\(s\) required \(0 present\)/);
  assert.match(formatPeerGoal(goal), /pi-subagents subagents 2 child, 1 done, 1 blocked/);

  await appendPeerGoalEvent(root, created.id, {
    type: "vote",
    peerId: "reviewer-a",
    verdict: "pass",
    summary: "top-level independent review pass",
  });
  goal = (await loadPeerGoalBoard(root)).goals[created.id];
  state = deriveGoalState(goal);
  assert.equal(state.independentPassingVotes.length, 1);
  assert.equal(state.readyToClose, true);
});

test("top-level child vote markers and count overrides persist without satisfying independent votes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-top-level-child-votes-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "top-level child vote markers",
    peerId: "planner",
    closurePolicy: { minIndependentVotes: 1 },
  });

  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "child-a", verdict: "pass", parentPeerId: "worker-a" });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "child-b", verdict: "pass", subagent: true });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-b", verdict: "pass", role: "reviewer", countsForIndependentVote: false });

  const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.passingVotes.length, 3);
  assert.equal(state.independentPassingVotes.length, 0);
  assert.equal(state.readyToClose, false);
  assert.equal(state.votes.find((vote) => vote.peerId === "child-a").parentPeerId, "worker-a");
  assert.equal(state.votes.find((vote) => vote.peerId === "child-b").subagent, true);
  assert.equal(state.votes.find((vote) => vote.peerId === "reviewer-b").role, "reviewer");
  assert.equal(state.votes.find((vote) => vote.peerId === "reviewer-b").countsForIndependentVote, false);
});

test("projectSubagentEvidence accepts completedCount as done count alias", () => {
  assert.deepEqual(
    projectSubagentEvidence({
      provider: "pi-subagents",
      childCount: 3,
      completedCount: 2,
      blockedCount: 1,
    }),
    {
      provider: "pi-subagents",
      childCount: 3,
      doneCount: 2,
      blockedCount: 1,
    },
  );
});

test("scout emits parallel closure-policy review lanes for unmet vote quorum", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-policy-scout-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "redundant review goal",
    peerId: "planner",
    closurePolicy: { minPassingVotes: 2 },
  });

  let suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
  let policyReviews = suggestions.filter((suggestion) => suggestion.summary.startsWith("Closure policy needs independent vote"));
  assert.equal(policyReviews.length, 2);
  assert.equal(new Set(policyReviews.map((suggestion) => suggestion.workKey)).size, 2);
  const [firstWorkKey, secondWorkKey] = policyReviews.map((suggestion) => suggestion.workKey);

  await appendPeerGoalEvent(root, created.id, {
    type: "claim",
    peerId: "reviewer-a",
    summary: policyReviews[0].summary,
    mode: "read",
    lane: "review",
    workKey: firstWorkKey,
  });

  suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
  policyReviews = suggestions.filter((suggestion) => suggestion.summary.startsWith("Closure policy needs independent vote"));
  assert.equal(policyReviews.length, 1);
  assert.equal(policyReviews[0].workKey, secondWorkKey);
  assert.equal(suggestions.some((suggestion) => suggestion.workKey === firstWorkKey), false);
});

test("scout keeps closure-policy work keys stable as vote counts progress", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-policy-stable-workkey-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "stable redundant review work keys",
    peerId: "planner",
    closurePolicy: { minPassingVotes: 2 },
  });

  let suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
  const slotTwo = suggestions.find((suggestion) => suggestion.summary.startsWith("Closure policy needs independent vote 2/2"));
  assert.ok(slotTwo);
  await appendPeerGoalEvent(root, created.id, {
    type: "claim",
    peerId: "reviewer-b",
    summary: slotTwo.summary,
    mode: "read",
    lane: "review",
    workKey: slotTwo.workKey,
  });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "first review pass" });

  suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
  assert.equal(suggestions.some((suggestion) => suggestion.summary.startsWith("Closure policy needs independent vote 2/2")), false);
});

test("scout gives distinct work keys to different closure-policy vote requirements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-policy-workkey-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await createPeerGoal(root, {
    objective: "role-specific redundant review goal",
    peerId: "planner",
    closurePolicy: {
      minPassingVotes: 1,
      requiredVotes: [
        { role: "qa", min: 1 },
        { role: "reviewer", min: 1 },
      ],
    },
  });

  const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
  const policyReviews = suggestions.filter((suggestion) => suggestion.summary.startsWith("Closure policy needs vote"));
  assert.equal(policyReviews.length, 2);
  assert.equal(new Set(policyReviews.map((suggestion) => suggestion.workKey)).size, 2);
  assert.equal(policyReviews.some((suggestion) => suggestion.workKey.includes("role=qa")), true);
  assert.equal(policyReviews.some((suggestion) => suggestion.workKey.includes("role=reviewer")), true);
});

test("closure policy can be supplied through goal metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-policy-metadata-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "metadata policy goal",
    peerId: "planner",
    metadata: { closurePolicy: { requiredEvidence: [{ type: "finding", lane: "security" }] } },
  });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "pass" });

  let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.closurePolicy.requiredEvidence[0].lane, "security");
  assert.equal(state.readyToClose, false);
  await appendPeerGoalEvent(root, created.id, { type: "finding", peerId: "security-a", lane: "security", summary: "Security evidence present" });
  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.readyToClose, true);
});

test("closure policy can require citation and fact-check quality evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-quality-policy-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "research quality gated goal",
    peerId: "planner",
    closurePolicy: {
      minPassingVotes: 1,
      requiredEvidence: [
        { type: "finding", lane: "research", minCitations: 2, minFactChecks: 1, requireLimitations: true, minConfidence: 0.7 },
      ],
    },
  });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "structure looks good" });
  await appendPeerGoalEvent(root, created.id, {
    type: "finding",
    peerId: "researcher-a",
    lane: "research",
    summary: "Insufficient quality evidence",
    metadata: { quality: { citations: ["README.md"], factChecks: [], limitations: ["repo-only"], confidence: 0.8 } },
  });

  let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.readyToClose, false);
  assert.match(state.closurePolicyStatus.missing.map((item) => item.summary).join("\n"), /quality\(citations>=2, factChecks>=1, limitations required, confidence>=0\.7\)/);
  assert.throws(() => validateGoalReadyToClose(state), /unmet closure policy requirements/);

  await appendPeerGoalEvent(root, created.id, {
    type: "finding",
    peerId: "researcher-bad-confidence",
    lane: "research",
    summary: "Otherwise sufficient quality evidence with invalid confidence",
    metadata: { quality: { citations: ["README.md", "test/peer-goal-board.test.mjs"], factChecks: ["closure gate claim verified against tests"], limitations: ["no external web sources checked"], confidence: 2 } },
  });

  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.readyToClose, false);

  await appendPeerGoalEvent(root, created.id, {
    type: "finding",
    peerId: "researcher-b",
    lane: "research",
    summary: "Source-grounded research finding with checked claims",
    metadata: { quality: { citations: ["README.md", "test/peer-goal-board.test.mjs"], factChecks: ["closure gate claim verified against tests"], limitations: ["no external web sources checked"], confidence: 0.82 } },
  });

  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.closurePolicyStatus.satisfied, true);
  assert.equal(state.readyToClose, true);
  assert.doesNotThrow(() => validateGoalReadyToClose(state));
});

test("closure quality policy can use parsed handoff evidence metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-handoff-quality-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, {
    objective: "docs handoff quality gated goal",
    peerId: "planner",
    closurePolicy: {
      minPassingVotes: 1,
      requiredEvidence: [
        { type: "handoff", lane: "documentation", status: "done", quality: { minCitations: 1, minFactChecks: 1, requireLimitations: true } },
      ],
    },
  });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "doc ready if quality evidence exists" });
  await appendPeerGoalEvent(root, created.id, {
    type: "handoff",
    peerId: "doc-a",
    lane: "documentation",
    status: "done",
    summary: "Generated doc handoff",
    metadata: { handoffEvidence: { citations: ["README.md"], factChecks: ["template sections verified"], limitations: ["repo-local only"] } },
  });

  const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.readyToClose, true);
});

test("failed votes and active work still block closure even when closure policy is satisfied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-goal-policy-blockers-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const created = await createPeerGoal(root, { objective: "policy blockers", peerId: "planner", closurePolicy: { minPassingVotes: 1 } });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "pass" });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-b", verdict: "fail", summary: "not yet" });

  let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.closurePolicyStatus.satisfied, true);
  assert.equal(state.readyToClose, false);
  assert.throws(() => validateGoalReadyToClose(state), /failed peer votes/);

  const claim = await appendPeerGoalEvent(root, created.id, { type: "claim", peerId: "worker-a", summary: "finish work", mode: "read", workKey: "policy:blocker" });
  await appendPeerGoalEvent(root, created.id, { type: "vote", peerId: "reviewer-b", verdict: "pass", summary: "supersede fail" });
  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.failedVotes.length, 0);
  assert.equal(state.readyToClose, false);
  assert.throws(() => validateGoalReadyToClose(state), /active claims/);

  await appendPeerGoalEvent(root, created.id, { type: "release", peerId: "worker-a", resolves: claim.event.id, summary: "done" });
  state = deriveGoalState((await loadPeerGoalBoard(root)).goals[created.id]);
  assert.equal(state.readyToClose, true);
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

test("scout suggestions include explainable pressure scores with temporal decay", () => {
  const nowMs = Date.parse("2026-01-01T03:00:00.000Z");
  const board = {
    goals: {
      goal_old: {
        id: "goal_old",
        objective: "old proposal",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [
          { id: "proposal_old", type: "proposal", at: "2026-01-01T00:00:00.000Z", peerId: "planner", lane: "research", workKey: "research:old", summary: "Old research lane" },
        ],
      },
      goal_fresh: {
        id: "goal_fresh",
        objective: "fresh proposal",
        status: "open",
        updatedAt: "2026-01-01T02:55:00.000Z",
        events: [
          { id: "proposal_fresh", type: "proposal", at: "2026-01-01T02:55:00.000Z", peerId: "planner", lane: "research", workKey: "research:fresh", summary: "Fresh research lane" },
        ],
      },
      goal_blocked: {
        id: "goal_blocked",
        objective: "blocked goal",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [
          { id: "blocker_1", type: "objection", at: "2026-01-01T00:00:00.000Z", peerId: "reviewer", severity: "blocking", summary: "Must resolve" },
        ],
      },
    },
  };

  const suggestions = derivePeerGoalScoutSuggestions(board, { nowMs });
  assert.equal(suggestions[0].kind, "blocker");
  assert.equal(suggestions[0].pressureScore, 100);
  assert.equal(suggestions[0].pressureDecay, 0);
  const fresh = suggestions.find((item) => item.workKey === "research:fresh");
  const old = suggestions.find((item) => item.workKey === "research:old");
  assert.ok(fresh.pressureScore > old.pressureScore);
  assert.ok(old.pressureDecay > 0);
  assert.deepEqual(old.pressureReasons, ["open-proposal", "temporal-decay"]);
  assert.match(formatPeerGoalScout(board, { nowMs }), /pressure: \d+/);
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

    const dashPathRoot = await mkdtemp(join(tmpdir(), "pi-peer-goal-test-"));
    t.after(async () => {
      await rm(dashPathRoot, { recursive: true, force: true });
    });
    const dashPathGoal = await createPeerGoal(dashPathRoot, { objective: "dash path", peerId: "tester" });
    await appendPeerGoalEvent(dashPathRoot, dashPathGoal.id, {
      type: "proposal",
      peerId: "planner-a",
      summary: "Review dash-prefixed fixtures",
      lane: "review",
      paths: ["--fixtures"],
      workKey: "epic:review:dash-fixtures",
    });
    const dashPathScoutText = formatPeerGoalScout(await loadPeerGoalBoard(dashPathRoot));
    const dashPathClaim = dashPathScoutText.match(/claim: (\/peer goal claim .*)/)?.[1];
    assert.ok(dashPathClaim);
    const parsedDashPathClaim = parsePeerCommand(dashPathClaim.replace(/^\/peer\s+/, ""));
    assert.deepEqual(parsedDashPathClaim.paths, ["--fixtures"]);

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
    assert.match(formatPeerGoalScout(await loadPeerGoalBoard(root)), new RegExp(`resolve: /peer goal resolve ${goalId} ${state.openProposals[0].id}`));

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

test("resolved proposal work keys reject stale prompt fulfillment", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const workKey = "proposal:idempotency";
    const proposal = await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "planner",
      summary: "Review stale prompt idempotency",
      lane: "review",
      paths: ["src/peers/goal-board.mjs"],
      workKey,
    });
    const claim = await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "reviewer-a",
      summary: "Self-select proposal lane",
      mode: "read",
      lane: "review",
      paths: ["src/peers/goal-board.mjs"],
      workKey,
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "finding",
      peerId: "reviewer-a",
      summary: "Proposal work completed",
      lane: "review",
      workKey,
    });
    await appendPeerGoalEvent(root, goalId, { type: "release", peerId: "reviewer-a", resolves: claim.event.id, summary: "review done" });
    await appendPeerGoalEvent(root, goalId, { type: "resolve", peerId: "coordinator", resolves: proposal.event.id, summary: "proposal fulfilled", workKey });

    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "claim",
        peerId: "stale-reviewer",
        summary: "Stale idle prompt claim",
        mode: "read",
        lane: "review",
        paths: ["src/peers/goal-board.mjs"],
        workKey,
      }),
      /already fulfilled by resolved proposal/,
    );
    await assert.rejects(
      beginPeerGoalTask(root, goalId, {
        targetPeerId: "stale-worker",
        prompt: "Stale dispatched prompt",
        mode: "read",
        lane: "review",
        workKey,
        duplicatePolicy: "reuse",
      }),
      /already fulfilled by resolved proposal/,
    );
    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "finding",
        peerId: "stale-reviewer",
        summary: "Stale duplicate evidence",
        lane: "review",
        workKey,
      }),
      /already fulfilled by resolved proposal/,
    );
    await assert.rejects(
      appendPeerGoalEvent(root, goalId, { type: "resolve", peerId: "stale-reviewer", resolves: proposal.event.id, summary: "duplicate resolve", workKey }),
      /already resolved/,
    );

    const parallel = await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "reviewer-b",
      summary: "Explicit parallel follow-up",
      mode: "read",
      lane: "review",
      workKey,
      duplicatePolicy: "allow-parallel",
    });
    assert.equal(parallel.event.duplicatePolicy, "allow-parallel");
  });
});

test("scout keeps open proposals ahead of proactive close suggestions", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "planner",
      summary: "Clarify human acceptance criteria",
      lane: "coordination",
      workKey: "acceptance-criteria",
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "vote",
      peerId: "reviewer",
      verdict: "pass",
      summary: "Implementation is otherwise safe",
    });

    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.readyToClose, false);
    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(suggestions.some((suggestion) => suggestion.kind === "close"), false);
    assert.equal(suggestions.some((suggestion) => suggestion.summary.startsWith("Self-select proposed coordination lane")), true);
    assert.equal(suggestions.some((suggestion) => suggestion.summary.startsWith("Triage 1 open proposal")), true);
  });
});

test("stale-only goals do not emit generic startup lane suggestions", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: "Old implementation lane",
      mode: "read",
      lane: "implementation",
      workKey: "old-implementation",
      staleAfterMs: 1,
    });
    await delay(5);

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(suggestions.some((suggestion) => suggestion.kind === "stale-claim"), true);
    assert.equal(suggestions.some((suggestion) => suggestion.kind === "next-step"), false);
    assert.equal(suggestions.some((suggestion) => suggestion.kind === "review"), false);
  });
});

test("stale-claim scout remains advisory and keeps unrelated lane work visible", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "claim",
      peerId: "worker-a",
      summary: "Old review lane",
      mode: "read",
      lane: "review",
      workKey: "old-review",
      staleAfterMs: 1,
    });
    await delay(5);
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "planner",
      summary: "Fresh research lane",
      lane: "research",
      workKey: "fresh-research",
    });

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(suggestions.some((suggestion) => suggestion.kind === "stale-claim"), true);
    assert.equal(suggestions.some((suggestion) => suggestion.workKey === "fresh-research"), true);
  });
});

test("proposal triage stays quiet when every proposal already has an active owner", async (t) => {
  await withGoal(t, async (root, goalId) => {
    for (const workKey of ["loop-1", "loop-2", "loop-3"]) {
      await appendPeerGoalEvent(root, goalId, {
        type: "proposal",
        peerId: "planner",
        summary: `Owned ${workKey} work`,
        lane: "review",
        workKey,
      });
      await appendPeerGoalEvent(root, goalId, {
        type: "claim",
        peerId: `worker-${workKey}`,
        summary: `Claim ${workKey}`,
        mode: "read",
        lane: "review",
        workKey,
      });
    }

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(suggestions.some((suggestion) => suggestion.summary.startsWith("Triage")), false);
    assert.equal(suggestions.some((suggestion) => suggestion.summary.startsWith("Self-select proposed review lane")), false);
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

test("beginPeerGoalTask reuses active task work keys even without an active claim", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const workKey = derivePeerGoalWorkKey({ goalId, lane: "review", objective: "Review task-only duplicate prevention", mode: "read" });
    await appendPeerGoalEvent(root, goalId, {
      type: "task",
      peerId: "planner",
      summary: "Review task-only duplicate prevention",
      status: "running",
      taskId: "msg_running_only",
      lane: "review",
      workKey,
    });

    const duplicate = await beginPeerGoalTask(root, goalId, {
      targetPeerId: "reviewer-b",
      prompt: "Review task-only duplicate prevention",
      mode: "read",
      lane: "review",
      workKey,
      duplicatePolicy: "reuse",
    });

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.existingClaim, undefined);
    assert.equal(duplicate.existingTask.taskId, "msg_running_only");

    const parallel = await beginPeerGoalTask(root, goalId, {
      targetPeerId: "reviewer-c",
      prompt: "Independent second opinion",
      mode: "read",
      lane: "review",
      workKey,
      duplicatePolicy: "allow-parallel",
    });
    assert.equal(parallel.duplicate, undefined);
    assert.equal(parallel.claimEvent.workKey, workKey);
  });
});

test("active task work keys prevent direct duplicate claims", async (t) => {
  await withGoal(t, async (root, goalId) => {
    const workKey = derivePeerGoalWorkKey({ goalId, lane: "review", objective: "Direct claim duplicate prevention", mode: "read" });
    await appendPeerGoalEvent(root, goalId, {
      type: "task",
      peerId: "planner",
      summary: "Direct claim duplicate prevention",
      status: "running",
      taskId: "msg_direct_duplicate",
      lane: "review",
      workKey,
    });

    await assert.rejects(
      appendPeerGoalEvent(root, goalId, {
        type: "claim",
        peerId: "reviewer-b",
        summary: "Direct claim duplicate prevention too",
        mode: "read",
        lane: "review",
        workKey,
      }),
      /duplicates active work key/,
    );
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

test("scout suppresses proposal suggestions whose work key is actively running as a task", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "planner",
      summary: "Task-owned review lane",
      lane: "review",
      workKey: "review:task-owned",
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId: "planner",
      summary: "Still unclaimed review lane",
      lane: "review",
      workKey: "review:unclaimed",
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "task",
      peerId: "planner",
      summary: "Task-owned review lane",
      status: "running",
      taskId: "msg_task_owned",
      lane: "review",
      workKey: "review:task-owned",
    });

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(suggestions.some((suggestion) => suggestion.workKey === "review:task-owned" && suggestion.summary.startsWith("Self-select")), false);
    assert.equal(suggestions.some((suggestion) => suggestion.workKey === "review:unclaimed" && suggestion.summary.startsWith("Self-select")), true);
    assert.equal(suggestions.some((suggestion) => /1 unclaimed actionable; 1 active-owned/.test(suggestion.summary)), true);
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
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "Done handoffs reviewed" });
    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.tasks.find((item) => item.id === planned.event.id).status, "done");
    assert.equal(state.unresolvedTaskHandoffs.length, 0);
    assert.equal(state.readyToClose, true);
  });

  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "Ready once peer failure is resolved" });
    const link = await beginPeerGoalTask(root, goalId, {
      targetPeerId: "worker-a",
      prompt: "Review with possible failure",
      mode: "read",
      lane: "review",
      duplicatePolicy: "reuse",
    });
    await recordPeerGoalTaskDispatch(root, goalId, {
      requesterPeerId: "planner",
      targetPeerId: "worker-a",
      prompt: "Review with possible failure",
      mode: "read",
      lane: "review",
      workKey: link.workKey,
      messageId: "msg_blocked_review",
      conversationId: "conv_blocked_review",
      claimEventId: link.claimEvent.id,
    });
    await completePeerGoalTask(root, goalId, {
      targetPeerId: "worker-a",
      messageId: "msg_blocked_review",
      conversationId: "conv_blocked_review",
      claimEventId: link.claimEvent.id,
      workKey: link.workKey,
      status: "blocked",
      responseStatus: "ERROR",
      summary: "ERROR: agent_end did not include final assistant text",
    });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].status, "blocked");
    assert.equal(state.tasks[0].handoffEventId.startsWith("evt_handoff_"), true);
    assert.ok(state.tasks[0].completedAt);
    assert.equal(state.activeClaims.length, 0);
    assert.equal(state.activeTasks.length, 0);
    assert.equal(state.unresolvedTaskHandoffs.length, 1);
    assert.equal(state.unresolvedTaskHandoffs[0].handoffEventId, state.tasks[0].handoffEventId);
    assert.equal(state.readyToClose, false);

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root));
    assert.equal(suggestions[0].kind, "task-handoff");
    assert.equal(suggestions[0].priority, "P0");
    assert.match(suggestions[0].summary, /Resolve 1 unsuccessful peer handoff/);
    assert.match(formatPeerGoal(state), new RegExp(`/peer goal resolve ${goalId} ${state.tasks[0].handoffEventId}`));

    await appendPeerGoalEvent(root, goalId, {
      type: "resolve",
      peerId: "planner",
      resolves: state.tasks[0].handoffEventId,
      summary: "Accepted failed peer attempt and no longer blocking closure",
    });
    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.unresolvedTaskHandoffs.length, 0);
    assert.equal(state.readyToClose, true);
  });

  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: "Ready once late evidence is counted" });
    const link = await beginPeerGoalTask(root, goalId, {
      targetPeerId: "worker-a",
      prompt: "Research with late evidence",
      mode: "read",
      lane: "research",
      duplicatePolicy: "reuse",
      workKey: "late:evidence",
    });
    await recordPeerGoalTaskDispatch(root, goalId, {
      requesterPeerId: "planner",
      targetPeerId: "worker-a",
      prompt: "Research with late evidence",
      mode: "read",
      lane: "research",
      workKey: link.workKey,
      messageId: "msg_late_evidence",
      conversationId: "conv_late_evidence",
      claimEventId: link.claimEvent.id,
    });
    await completePeerGoalTask(root, goalId, {
      targetPeerId: "worker-a",
      messageId: "msg_late_evidence",
      conversationId: "conv_late_evidence",
      claimEventId: link.claimEvent.id,
      workKey: link.workKey,
      status: "blocked",
      responseStatus: "ERROR",
      summary: "ERROR: local peer closed before final text",
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "finding",
      peerId: "worker-a",
      lane: "research",
      workKey: link.workKey,
      summary: "Late evidence arrived after the transport close event",
    });

    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.tasks[0].status, "superseded");
    assert.equal(state.tasks[0].evidenceEventId.startsWith("evt_finding_"), true);
    assert.equal(state.activeTasks.length, 0);
    assert.equal(state.unresolvedTaskHandoffs.length, 0);
    assert.equal(state.readyToClose, true);
  });

  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "task",
      peerId: "planner",
      summary: "Manual blocked work remains active until a handoff resolves it",
      taskId: "manual-blocked-task",
      status: "blocked",
    });
    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.activeTasks.length, 1);
  });

  for (const status of ["partial", "ERROR"]) {
    await withGoal(t, async (root, goalId) => {
      await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "reviewer-a", verdict: "pass", summary: `Ready after ${status} is resolved` });
      await appendPeerGoalEvent(root, goalId, {
        type: "task",
        peerId: "planner",
        summary: `${status} handoff task`,
        taskId: `task-${status}`,
        status: "running",
      });
      await appendPeerGoalEvent(root, goalId, {
        type: "handoff",
        peerId: "worker-a",
        summary: `${status} handoff`,
        taskId: `task-${status}`,
        status,
      });
      const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
      assert.equal(state.activeTasks.length, 0);
      assert.equal(state.unresolvedTaskHandoffs.length, 1);
      assert.equal(state.readyToClose, false);
    });
  }
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
