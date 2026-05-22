import test from "node:test";
import assert from "node:assert/strict";

import { derivePeerGoalWorkKey } from "../src/peers/goal-board.mjs";
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

test("peer status can show visible unknown context after compaction", () => {
  const status = derivePeerRuntimeStatus({ enabled: true, localPeerId: "self", source: "test", contextBudget: { available: true, pressure: "unknown", source: "post-compaction" } }, { peers: [], messages: [] });
  const text = formatPeerStatusText(status);
  assert.match(text, /context unknown/);
  assert.match(text, /judgement continue/);
  assert.doesNotMatch(text, /context tight/);
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

test("goal dashboard groups implicit proposal work keys like scout", () => {
  const goalId = "goal_dash_implicit";
  const activeKey = derivePeerGoalWorkKey({ goalId, lane: "review", objective: "Implicit active lane", mode: "read", paths: ["README.md"] });
  const aliasKey = derivePeerGoalWorkKey({ goalId, lane: "review", objective: "Implicit qa lane", mode: "read", paths: ["test"] });
  const doneKey = derivePeerGoalWorkKey({ goalId, lane: "implementation", objective: "Implicit done lane", mode: "read", paths: ["src/x.mjs"] });
  const goal = {
    id: goalId,
    objective: "Test implicit proposal dashboard",
    status: "open",
    events: [
      { id: "p1", type: "proposal", at: "2026-01-01T00:00:00.000Z", peerId: "planner", summary: "Implicit active lane", lane: "review", paths: ["README.md"] },
      { id: "c1", type: "claim", at: "2026-01-01T00:00:01.000Z", peerId: "reviewer", summary: "Implicit active lane", mode: "read", lane: "review", workKey: activeKey, paths: ["README.md"], staleAfterMs: 900000 },
      { id: "p_alias", type: "proposal", at: "2026-01-01T00:00:02.000Z", peerId: "planner", summary: "Implicit qa lane", lane: "qa", paths: ["test"] },
      { id: "t_alias", type: "task", at: "2026-01-01T00:00:02.500Z", peerId: "planner", summary: "Implicit qa lane", status: "running", taskId: "msg_alias", lane: "review", workKey: aliasKey },
      { id: "p2", type: "proposal", at: "2026-01-01T00:00:03.000Z", peerId: "planner", summary: "Implicit done lane", lane: "implementation", paths: ["src/x.mjs"] },
      { id: "c2", type: "claim", at: "2026-01-01T00:00:04.000Z", peerId: "worker", summary: "Implicit done lane", mode: "read", lane: "implementation", workKey: doneKey, paths: ["src/x.mjs"], staleAfterMs: 900000 },
      { id: "h2", type: "handoff", at: "2026-01-01T00:00:05.000Z", peerId: "worker", summary: "done", lane: "implementation", status: "done", workKey: doneKey },
      { id: "r2", type: "release", at: "2026-01-01T00:00:06.000Z", peerId: "worker", summary: "done", resolves: "c2" },
    ],
  };

  const text = formatPeerGoalDashboard(goal, { now: "2026-01-01T00:05:00.000Z" });
  assert.match(text, /active-owned: 2/);
  assert.match(text, /fulfilled-awaiting-resolve: 1/);
  assert.match(text, /\/peer goal resolve goal_dash_implicit p2/);
  assert.doesNotMatch(text, /unclaimed:/);
});

test("goal dashboard derives implicit proposal keys when lane is omitted", () => {
  const text = formatPeerGoalDashboard({
    id: "goal_no_lane",
    objective: "No lane implicit proposal",
    status: "open",
    events: [
      { id: "p1", type: "proposal", at: "2026-01-01T00:00:00.000Z", peerId: "planner", summary: "No lane implicit", paths: ["README.md"] },
    ],
  }, { now: "2026-01-01T00:05:00.000Z" });

  assert.match(text, /unclaimed: 1/);
  assert.match(text, /--lane review/);
  assert.match(text, /--key 'goal_no_lane\|review\|no lane implicit\|read\|readme\.md'/);
});

test("goal dashboard safe next actions wait for active tasks", () => {
  const goal = {
    id: "goal_active_task",
    objective: "Do not suggest mutation while tasks run",
    status: "open",
    events: [
      { id: "t1", type: "task", at: "2026-01-01T00:00:00.000Z", peerId: "planner", summary: "Running review", status: "running", taskId: "msg_active", lane: "review", workKey: "review:active" },
    ],
  };

  const text = formatPeerGoalDashboard(goal, { now: "2026-01-01T00:05:00.000Z" });
  assert.match(text, /wait: active peer task\(s\) are still running/);
  assert.doesNotMatch(text, /no mutation suggested/);
  assert.doesNotMatch(text, /\/peer goal vote goal_active_task pass/);
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
