import test from "node:test";
import assert from "node:assert/strict";

import { deriveFanoutSuggestion, derivePeerRuntimeStatus, formatPeerGoalDashboard, formatPeerStatusText } from "../src/peers/status.mjs";

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

test("peer status includes local context pressure when available", () => {
  const status = derivePeerRuntimeStatus({ enabled: true, localPeerId: "self", source: "test", contextBudget: { tokens: 95_000, contextWindow: 100_000 } }, { peers: [], messages: [] });
  assert.equal(status.contextBudget.pressure, "critical");
  const text = formatPeerStatusText(status);
  assert.match(text, /context critical/);
  assert.match(text, /5\.0k left/);
  assert.match(text, /judgement compact_or_delegate/);
});

test("goal dashboard surfaces unresolved peer handoff resolution actions", () => {
  const goal = {
    id: "goal_unresolved_handoff",
    objective: "Test unresolved handoff dashboard",
    status: "open",
    events: [
      { id: "t1", type: "task", at: "2026-01-01T00:00:00.000Z", peerId: "planner", summary: "Review failed task", taskId: "msg_failed", status: "running" },
      { id: "h1", type: "handoff", at: "2026-01-01T00:00:01.000Z", peerId: "worker", summary: "agent_end missing final text", taskId: "msg_failed", status: "blocked" },
      { id: "v1", type: "vote", at: "2026-01-01T00:00:02.000Z", peerId: "reviewer", summary: "otherwise ready", verdict: "pass" },
    ],
  };

  const text = formatPeerGoalDashboard(goal, { now: "2026-01-01T00:05:00.000Z" });
  assert.match(text, /ready: no/);
  assert.match(text, /unresolved handoffs 1/);
  assert.match(text, /Unresolved peer handoffs:/);
  assert.match(text, /h1 · worker: blocked · agent_end missing final text/);
  assert.match(text, /\/peer goal resolve goal_unresolved_handoff h1/);
  assert.doesNotMatch(text, /no mutation suggested/);
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
      { id: "p4", type: "proposal", at: "2026-01-01T00:00:07.000Z", peerId: "planner", summary: "Task-owned lane", lane: "review", workKey: "review:task" },
      { id: "t4", type: "task", at: "2026-01-01T00:00:08.000Z", peerId: "planner", summary: "Task-owned lane", status: "running", taskId: "msg_task_owned", lane: "review", workKey: "review:task" },
    ],
  };

  const text = formatPeerGoalDashboard(goal, { now: "2026-01-01T00:05:00.000Z" });
  assert.match(text, /unclaimed: 1/);
  assert.match(text, /active-owned: 2/);
  assert.match(text, /fulfilled-awaiting-resolve: 1/);
  assert.match(text, /\/peer goal claim goal_dash/);
  assert.match(text, /\/peer goal resolve goal_dash p3/);
  assert.match(text, /Peer contribution\/load/);
});

test("goal dashboard surfaces unresolved peer handoffs with resolve action", () => {
  const goal = {
    id: "goal_handoff",
    objective: "Review unresolved handoff UX",
    status: "open",
    events: [
      { id: "v1", type: "vote", at: "2026-01-01T00:00:00.000Z", peerId: "reviewer", verdict: "pass", summary: "ready once handoff is resolved" },
      { id: "t1", type: "task", at: "2026-01-01T00:00:01.000Z", peerId: "planner", summary: "Peer review task", status: "running", taskId: "msg_partial", lane: "review", workKey: "review:partial" },
      { id: "h1", type: "handoff", at: "2026-01-01T00:00:02.000Z", peerId: "worker", summary: "Peer review blocked", status: "partial", taskId: "msg_partial", lane: "review", workKey: "review:partial" },
    ],
  };

  const text = formatPeerGoalDashboard(goal, { now: "2026-01-01T00:05:00.000Z" });
  assert.match(text, /ready: no/);
  assert.match(text, /active tasks 0 · unresolved handoffs 1/);
  assert.match(text, /Unresolved peer handoffs:/);
  assert.match(text, /h1 · worker: partial · Peer review blocked/);
  assert.match(text, /\/peer goal resolve goal_handoff h1/);
  assert.doesNotMatch(text, /no mutation suggested/);
});
