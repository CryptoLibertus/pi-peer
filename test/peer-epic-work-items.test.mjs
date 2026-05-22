import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  appendPeerGoalEvent,
  closePeerGoal,
  createPeerGoal,
  deriveGoalState,
  derivePeerGoalScoutSuggestions,
  loadPeerGoalBoard,
  validateGoalReadyToClose,
} from "../src/peers/goal-board.mjs";

async function withGoal(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-work-items-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const goal = await createPeerGoal(root, { objective: "ship epic work items", peerId: "planner" });
  return fn(root, goal.id);
}

test("epic work items are first-class closure gates with dependency status", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId: "planner",
      itemId: "research",
      summary: "Map the implementation plan",
      lane: "research",
      status: "done",
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId: "planner",
      itemId: "implementation",
      parentId: "epic",
      dependsOn: ["research"],
      summary: "Implement the feature",
      lane: "implementation",
      status: "open",
      paths: ["src/peers/goal-board.mjs"],
    });
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "reviewer", verdict: "pass", summary: "looks ready" });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.workItems.length, 2);
    assert.equal(state.openWorkItems.map((item) => item.itemId).join(","), "implementation");
    assert.equal(state.readyToClose, false);
    assert.throws(() => validateGoalReadyToClose(state), /open work items: implementation/);

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root), { goalId });
    const itemSuggestion = suggestions.find((item) => item.kind === "work-item" && item.relatedEventId === state.openWorkItems[0].id);
    assert.ok(itemSuggestion);
    assert.equal(itemSuggestion.recommendedLane, "implementation");

    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId: "worker",
      itemId: "implementation",
      summary: "Implementation complete",
      lane: "implementation",
      status: "done",
    });
    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.openWorkItems.length, 0);
    assert.equal(state.blockedWorkItems.length, 0);
    assert.equal(state.readyToClose, true);

    const closed = await closePeerGoal(root, goalId, { peerId: "planner" });
    assert.equal(closed.status, "closed");
  });
});

test("work item updates can explicitly clear dependencies", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId: "planner",
      itemId: "implementation",
      dependsOn: ["research"],
      summary: "Implementation depends on research",
      lane: "implementation",
      status: "open",
    });
    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId: "worker",
      itemId: "implementation",
      summary: "Implementation still preserves omitted dependencies",
      status: "open",
    });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.deepEqual(state.workItems[0].dependsOn, ["research"]);
    assert.deepEqual(state.workItems[0].blockedBy, ["research"]);

    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId: "planner",
      itemId: "implementation",
      dependsOn: [],
      summary: "Implementation no longer depends on research",
      status: "open",
    });
    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.workItems[0].dependsOn, undefined);
    assert.equal(state.workItems[0].blockedBy, undefined);
  });
});

test("epic work items cannot satisfy closure while dependencies are incomplete", async (t) => {
  await withGoal(t, async (root, goalId) => {
    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId: "planner",
      itemId: "implementation",
      dependsOn: ["research"],
      summary: "Implementation says done too early",
      lane: "implementation",
      status: "done",
    });
    await appendPeerGoalEvent(root, goalId, { type: "vote", peerId: "reviewer", verdict: "pass", summary: "ready" });

    let state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.openWorkItems.length, 0);
    assert.equal(state.blockedWorkItems.length, 1);
    assert.deepEqual(state.blockedWorkItems[0].blockedBy, ["research"]);
    assert.equal(state.readyToClose, false);
    assert.throws(() => validateGoalReadyToClose(state), /dependency-blocked work items: implementation/);

    const suggestions = derivePeerGoalScoutSuggestions(await loadPeerGoalBoard(root), { goalId });
    assert.equal(suggestions.some((item) => item.kind === "work-item" && item.recommendedLane === "implementation"), false);
    assert.equal(suggestions[0].kind, "work-item");
    assert.equal(suggestions[0].recommendedLane, "coordination");
    assert.match(suggestions[0].summary, /Resolve dependencies/);

    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId: "researcher",
      itemId: "research",
      summary: "Research complete",
      lane: "research",
      status: "done",
    });
    state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goalId]);
    assert.equal(state.blockedWorkItems.length, 0);
    assert.equal(state.readyToClose, true);
  });
});
