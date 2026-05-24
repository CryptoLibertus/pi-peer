import test from "node:test";
import assert from "node:assert/strict";

import { derivePeerGoalWorkKey } from "../src/peers/goal-board.mjs";
import { parsePeerCommand } from "../src/peers/command.mjs";
import { deriveFanoutSuggestion, derivePeerRuntimeStatus, formatPeerFooterStatusLine, formatPeerGoalDashboard, formatPeerStatusText } from "../src/peers/status.mjs";

test("fanout suggestion groups available peers by persona-aware lanes", () => {
  const suggestion = deriveFanoutSuggestion([
    { peerId: "reviewer-a", role: "reviewer", domain: "protocol", status: "active" },
    { peerId: "worker3", status: "active" },
    { peerId: "planner-a", role: "coordinator", status: "active" },
    { peerId: "self", current: true, status: "active" },
  ], []);

  assert.equal(suggestion.recommended, true);
  assert.deepEqual(suggestion.lanes.review, ["reviewer-a"]);
  assert.deepEqual(suggestion.lanes.implementation, ["worker3"]);
  assert.deepEqual(suggestion.lanes.coordination, ["planner-a"]);
  assert.equal(suggestion.availablePeerDetails.find((peer) => peer.peerId === "reviewer-a").domain, "protocol");
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

test("peer status surfaces local domain and subagent capability summary", () => {
  const status = derivePeerRuntimeStatus({
    enabled: true,
    localPeerId: "planner-a",
    source: "test",
    summary: { localPeerProfile: { role: "planner", domain: "protocol" } },
    config: {
      manifest: {
        capabilities: {
          orchestration: { subagents: true, provider: "pi-subagents", modes: ["single", "parallel"] },
        },
      },
    },
  }, { peers: [], messages: [] });

  const text = formatPeerStatusText(status);
  assert.match(text, /role planner/);
  assert.match(text, /domain protocol/);
  assert.match(text, /subagents:pi-subagents\(single,parallel\)/);
});

test("peer status includes idle watcher diagnostics", () => {
  const status = derivePeerRuntimeStatus({
    enabled: true,
    localPeerId: "self",
    source: "test",
    __peerIdleWatcher: {
      config: { enabled: true, maxActivationsPerSession: 20, protocolOffers: true },
      state: {
        running: true,
        checkCount: 3,
        activationCount: 1,
        lastCheck: {
          at: "2026-01-01T00:00:00.000Z",
          reason: "goal-board-change",
          activated: false,
          noOpReason: "no idle activation",
        },
      },
    },
    __peerIdleOfferLastSweep: { reason: "agent_end", sent: 2, duplicate: 1, errors: 0, skipped: 0 },
  }, { peers: [], messages: [] });

  assert.equal(status.idleWatcher.running, true);
  assert.equal(status.idleWatcher.lastCheck.noOpReason, "no idle activation");
  const text = formatPeerStatusText(status);
  assert.match(text, /idle watcher running/);
  assert.match(text, /activations 1\/20/);
  assert.match(text, /last no-op no idle activation \(goal-board-change\)/);
  assert.match(text, /offers 2 sent · 1 duplicate/);
});

test("peer status summarizes the last idle activation", () => {
  const status = derivePeerRuntimeStatus({
    enabled: true,
    localPeerId: "self",
    source: "test",
    __peerIdleWatcher: {
      config: { enabled: true, maxActivationsPerSession: 5 },
      state: {
        running: true,
        checkCount: 1,
        activationCount: 1,
        lastCheck: {
          reason: "timer",
          activated: true,
          activation: { kind: "work-item", goalId: "goal_1", workKey: "run:loop:6" },
        },
      },
    },
  }, { peers: [], messages: [] });

  const text = formatPeerStatusText(status);
  assert.match(text, /idle watcher running/);
  assert.match(text, /last work-item goal_1 key run:loop:6 \(timer\)/);
});

test("peer footer status prioritizes coordination activations and protocol offers", () => {
  const coordinationStatus = derivePeerRuntimeStatus({
    enabled: true,
    localPeerId: "self",
    source: "test",
    __peerIdleWatcher: {
      config: { enabled: true },
      state: {
        running: true,
        lastCheck: {
          reason: "goal-board-change",
          activated: true,
          activation: { kind: "task-handoff", goalId: "goal_noise", workKey: "goal_noise|coordination|resolve|read", recommendedLane: "coordination" },
        },
      },
    },
  }, { peers: [], messages: [] });
  assert.equal(formatPeerFooterStatusLine(coordinationStatus).text, "🔗 needs handoff review · goal_noise · no peers online");

  const offerStatus = derivePeerRuntimeStatus({
    enabled: true,
    localPeerId: "self",
    source: "test",
    __peerIdleOfferLastSweep: { reason: "agent_end", sent: 1, duplicate: 0, errors: 0, skipped: 2 },
  }, { peers: [{ peerId: "worker2", status: "active" }], messages: [] });
  assert.equal(formatPeerFooterStatusLine(offerStatus).text, "🔗 offers · 1 sent · 2 skipped · online worker2");

  const workStatus = derivePeerRuntimeStatus({ enabled: true, localPeerId: "self", source: "test" }, {
    peers: [
      { peerId: "self", status: "active", current: true },
      { peerId: "worker3", status: "active" },
      { peerId: "worker4", status: "active" },
    ],
    messages: [{ messageId: "msg_1", peerId: "worker2", status: "running", request: { body: { intent: "task", metadata: {} } } }],
  });
  assert.equal(formatPeerFooterStatusLine(workStatus).text, "🔗 busy · 1 task: worker2 work · online worker3, worker4");
});

test("peer footer lists online peers and useful recovery commands", () => {
  const onlineStatus = derivePeerRuntimeStatus({ enabled: true, localPeerId: "self", source: "test" }, {
    peers: [
      { peerId: "self", status: "active", current: true },
      { peerId: "worker2", status: "active" },
      { peerId: "worker3", status: "active" },
      { peerId: "worker4", status: "active" },
      { peerId: "coordinator", status: "configured" },
    ],
    messages: [],
  });
  assert.equal(formatPeerFooterStatusLine(onlineStatus).text, "🔗 3 peers online: worker2, worker3, worker4 · 1 offline");

  const truncatedStatus = derivePeerRuntimeStatus({ enabled: true, localPeerId: "self", source: "test" }, {
    peers: ["worker2", "worker3", "worker4", "reviewer-a"].map((peerId) => ({ peerId, status: "active" })),
    messages: [],
  });
  assert.equal(formatPeerFooterStatusLine(truncatedStatus).text, "🔗 4 peers online: worker2, worker3, worker4 +1");

  const noPeersStatus = derivePeerRuntimeStatus({ enabled: true, localPeerId: "self", source: "test" }, { peers: [], messages: [] });
  const noPeersFooter = formatPeerFooterStatusLine(noPeersStatus);
  assert.equal(noPeersFooter.text, "🔗 no peers online · /peer reconnect");
  assert.equal(noPeersFooter.color, "warning");

  const disabledStatus = derivePeerRuntimeStatus({ enabled: false, localPeerId: "self", source: "test" }, { peers: [], messages: [] });
  const disabledFooter = formatPeerFooterStatusLine(disabledStatus);
  assert.equal(disabledFooter.text, "🔗 peer messaging off · /peer setup");
  assert.equal(disabledFooter.color, "muted");
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

test("goal dashboard surfaces compact subagent evidence", () => {
  const text = formatPeerGoalDashboard({
    id: "goal_subagents",
    objective: "Test subagent evidence dashboard",
    status: "open",
    events: [
      {
        id: "h1",
        type: "handoff",
        at: "2026-01-01T00:00:00.000Z",
        peerId: "worker-a",
        summary: "implementation complete",
        status: "done",
        metadata: {
          subagentEvidence: {
            provider: "pi-subagents",
            childCount: 2,
            completedCount: 1,
            blockedCount: 1,
            artifactRefs: ["artifact:subrun-1"],
          },
        },
      },
    ],
  });

  assert.match(text, /Subagent evidence:/);
  assert.match(text, /h1 · worker-a · pi-subagents subagents 2 child, 1 done, 1 blocked · artifacts artifact:subrun-1/);
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

test("goal dashboard proposal claim round-trips dash-prefixed paths", () => {
  const text = formatPeerGoalDashboard({
    id: "goal_dash_path",
    objective: "Test dash-prefixed path dashboard",
    status: "open",
    events: [
      { id: "p1", type: "proposal", at: "2026-01-01T00:00:00.000Z", peerId: "planner", summary: "Review dash-prefixed fixtures", lane: "review", workKey: "review:dash-fixtures", paths: ["--fixtures"] },
    ],
  }, { now: "2026-01-01T00:05:00.000Z" });
  const command = text.match(/next: (\/peer goal claim .*)/)?.[1];
  assert.ok(command);
  const parsed = parsePeerCommand(command.replace(/^\/peer\s+/, ""));
  assert.deepEqual(parsed.paths, ["--fixtures"]);
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
