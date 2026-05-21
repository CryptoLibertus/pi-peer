import test from "node:test";
import assert from "node:assert/strict";

import { deriveFanoutSuggestion, formatPeerGoalDashboard } from "../src/peers/status.mjs";

test("fanout suggestion groups available peers by persona-aware lanes", () => {
  const suggestion = deriveFanoutSuggestion([
    { peerId: "reviewer-a", role: "reviewer", status: "active" },
    { peerId: "worker3", status: "active" },
    { peerId: "planner-a", role: "coordinator", status: "active" },
    { peerId: "self", current: true, status: "active" },
  ], []);

  assert.equal(suggestion.recommended, true);
  assert.deepEqual(suggestion.lanes.review, ["reviewer-a"]);
  assert.deepEqual(suggestion.lanes.implementation, ["worker3"]);
  assert.deepEqual(suggestion.lanes.coordination, ["planner-a"]);
  assert.match(suggestion.warning, /lanes/);
});

test("fanout suggestion is suppressed while peer tasks are active", () => {
  const suggestion = deriveFanoutSuggestion([{ peerId: "worker-a" }], [{ status: "running" }]);
  assert.equal(suggestion.recommended, false);
  assert.equal(suggestion.warning, undefined);
});

test("goal dashboard groups proposal state and prints safe next actions", () => {
  const goal = {
    id: "goal_dash",
    objective: "Test dashboard",
    status: "open",
    events: [
      { id: "p1", type: "proposal", at: "2026-01-01T00:00:00.000Z", peerId: "planner", summary: "Review docs", lane: "review", workKey: "review:docs", paths: ["README.md"] },
      { id: "p2", type: "proposal", at: "2026-01-01T00:00:01.000Z", peerId: "planner", summary: "Implement thing", lane: "implementation", workKey: "impl:thing", paths: ["src/x.mjs"] },
      { id: "c2", type: "claim", at: "2026-01-01T00:00:02.000Z", peerId: "worker", summary: "Implement thing", mode: "read", lane: "implementation", workKey: "impl:thing", paths: ["src/x.mjs"], staleAfterMs: 900000 },
      { id: "p3", type: "proposal", at: "2026-01-01T00:00:03.000Z", peerId: "planner", summary: "Finished lane", lane: "review", workKey: "review:done" },
      { id: "c3", type: "claim", at: "2026-01-01T00:00:04.000Z", peerId: "reviewer", summary: "Finished lane", mode: "read", lane: "review", workKey: "review:done" },
      { id: "f3", type: "finding", at: "2026-01-01T00:00:05.000Z", peerId: "reviewer", summary: "done", lane: "review", workKey: "review:done" },
      { id: "r3", type: "release", at: "2026-01-01T00:00:06.000Z", peerId: "reviewer", summary: "done", resolves: "c3" },
    ],
  };

  const text = formatPeerGoalDashboard(goal, { now: "2026-01-01T00:05:00.000Z" });
  assert.match(text, /unclaimed: 1/);
  assert.match(text, /active-owned: 1/);
  assert.match(text, /fulfilled-awaiting-resolve: 1/);
  assert.match(text, /\/peer goal claim goal_dash/);
  assert.match(text, /\/peer goal resolve goal_dash p3/);
  assert.match(text, /Peer contribution\/load/);
});
