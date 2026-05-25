import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPeerComms, MemoryPeerRegistry } from "../src/peers/comms.mjs";
import { peerResponseGoalStatus } from "../src/peers/extension-goal-linking.mjs";
import { createPeerEnvelope } from "../src/peers/protocol.mjs";
import { appendPeerGoalEvent, createPeerGoal, deriveGoalState, formatPeerGoalPlanVerification, formatPeerGoalSynthesis, loadPeerGoalBoard, verifyPeerGoalPlan } from "../src/peers/goal-board.mjs";
import { lintPeerHandoff, formatPeerHandoffPreflight, peerHandoffContract } from "../src/peers/tool-results.mjs";
import { parsePeerCommand } from "../src/peers/command.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-top5-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("handoff preflight contract reports missing fields before board closure", () => {
  assert.deepEqual(peerHandoffContract().requiredFields, ["Status", "Files changed", "Verification", "Blockers/risks", "Safe for review"]);
  const lint = lintPeerHandoff("Status: done\nFiles changed: none");
  assert.equal(lint.ok, false);
  assert.deepEqual(lint.missingFields, ["Verification", "Blockers/risks", "Safe for review"]);
  assert.match(formatPeerHandoffPreflight("Status: done"), /Handoff preflight: fail/);
});

test("peer comms attaches trace ids and retries to dead-letter", async () => {
  let calls = 0;
  const transport = {
    async send(envelope, peer) {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error(`boom ${calls}`), { code: "BOOM" });
      return createPeerEnvelope({
        type: "message.response",
        conversationId: envelope.conversationId,
        source: { peerId: peer.peerId, transport: "coms" },
        target: envelope.source,
        correlationId: envelope.id,
        causationId: envelope.id,
        body: { status: "OK", summary: "ok", finalAssistantMessage: "Status: done\nFiles changed: none\nVerification: not run - unit test\nBlockers/risks: none\nSafe for review: yes" },
      });
    },
  };
  const comms = createPeerComms({
    localPeerId: "planner",
    registry: new MemoryPeerRegistry([{ peerId: "worker", trust: "conversation" }]),
    transport,
  });
  const handle = await comms.sendMessage("worker", { prompt: "retry me" }, { maxAttempts: 3, retryBackoffMs: 1, traceId: "trace_test" });
  const response = await handle.response;
  const message = await comms.getMessage(handle.messageId);
  await comms.dispose();

  assert.equal(response.status, "OK");
  assert.equal(response.traceId, "trace_test");
  assert.equal(response.retry.attempts, 3);
  assert.equal(calls, 3);
  assert.equal(message.traceId, "trace_test");
  assert.ok(message.events.some((event) => event.type === "retry.scheduled"));
});

test("peer comms moves exhausted retried errors to dead-letter when requested", async () => {
  const comms = createPeerComms({
    localPeerId: "planner",
    registry: new MemoryPeerRegistry([{ peerId: "worker", trust: "conversation" }]),
    transport: { async send() { throw Object.assign(new Error("always down"), { code: "DOWN" }); } },
  });
  const handle = await comms.sendMessage("worker", { prompt: "fail" }, { maxAttempts: 2, retryBackoffMs: 1, deadLetterOnError: true });
  const response = await handle.response;
  const message = await comms.getMessage(handle.messageId);
  await comms.dispose();

  assert.equal(response.status, "ERROR");
  assert.equal(response.retry.deadLetter, true);
  assert.equal(message.status, "dead-letter");
  assert.ok(message.events.some((event) => event.type === "dead-letter"));
});

test("goal synthesis and plan verifier expose closure evidence and structural errors", async (t) => {
  await withRoot(t, async (root) => {
    const goal = await createPeerGoal(root, { objective: "ship better coordination", peerId: "planner" });
    await appendPeerGoalEvent(root, goal.id, { type: "finding", peerId: "reviewer", summary: "Retry lifecycle needs DLQ" });
    await appendPeerGoalEvent(root, goal.id, { type: "handoff", peerId: "worker", status: "done", summary: "Implemented retry lifecycle", metadata: { handoffEvidence: { verification: [{ command: "npm test", exitStatus: 0 }], citations: ["README.md"] } } });
    await appendPeerGoalEvent(root, goal.id, { type: "work-item", peerId: "planner", itemId: "a", summary: "A", dependsOn: ["b"] });
    await appendPeerGoalEvent(root, goal.id, { type: "work-item", peerId: "planner", itemId: "b", summary: "B", dependsOn: ["a"] });
    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goal.id]);

    const synthesis = formatPeerGoalSynthesis(state);
    assert.match(synthesis, /Retry lifecycle needs DLQ/);
    assert.match(synthesis, /npm test exit 0/);

    const verification = verifyPeerGoalPlan(state);
    assert.equal(verification.ok, false);
    assert.match(verification.errors.join("\n"), /dependency cycle/);
    assert.match(formatPeerGoalPlanVerification(state), /status: fail/);
  });
});

test("dead-letter handoff is terminal but unresolved for explicit triage", async (t) => {
  await withRoot(t, async (root) => {
    const goal = await createPeerGoal(root, { objective: "dead letter triage", peerId: "planner" });
    const claim = await appendPeerGoalEvent(root, goal.id, { type: "claim", peerId: "worker", summary: "Do risky work", mode: "read", workKey: "dead:key" });
    await appendPeerGoalEvent(root, goal.id, { type: "task", peerId: "planner", summary: "Dispatched risky work", status: "running", taskId: "msg_dead", workKey: "dead:key", metadata: { claimEventId: claim.event.id } });
    await appendPeerGoalEvent(root, goal.id, { type: "handoff", peerId: "worker", summary: "Retries exhausted", status: "dead-letter", taskId: "msg_dead", workKey: "dead:key" });
    await appendPeerGoalEvent(root, goal.id, { type: "release", peerId: "worker", resolves: claim.event.id, summary: "Released dead-lettered work" });
    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goal.id]);
    assert.equal(state.activeTasks.length, 0);
    assert.equal(state.unresolvedTaskHandoffs.length, 1);
    assert.equal(state.unresolvedTaskHandoffs[0].status, "dead-letter");
  });
});

test("goal plan verifier allows normal linked claim and task sharing a work key", async (t) => {
  await withRoot(t, async (root) => {
    const goal = await createPeerGoal(root, { objective: "linked active work", peerId: "planner" });
    const claim = await appendPeerGoalEvent(root, goal.id, { type: "claim", peerId: "worker", summary: "Do linked work", mode: "read", workKey: "linked:key" });
    await appendPeerGoalEvent(root, goal.id, { type: "task", peerId: "planner", summary: "Dispatched linked work", status: "running", taskId: "msg_1", workKey: "linked:key", metadata: { claimEventId: claim.event.id } });
    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goal.id]);
    assert.equal(verifyPeerGoalPlan(state).ok, true);
  });
});

test("goal plan verifier respects intentional allow-parallel duplicate work keys", async (t) => {
  await withRoot(t, async (root) => {
    const goal = await createPeerGoal(root, { objective: "parallel review", peerId: "planner" });
    await appendPeerGoalEvent(root, goal.id, { type: "claim", peerId: "reviewer-a", summary: "Review", mode: "read", workKey: "review:key", duplicatePolicy: "allow-parallel" });
    await appendPeerGoalEvent(root, goal.id, { type: "claim", peerId: "reviewer-b", summary: "Review independently", mode: "read", workKey: "review:key", duplicatePolicy: "allow-parallel" });
    const state = deriveGoalState((await loadPeerGoalBoard(root)).goals[goal.id]);
    assert.equal(verifyPeerGoalPlan(state).ok, true);
  });
});

test("dead-letter peer responses project to dead-letter goal task status", () => {
  assert.equal(peerResponseGoalStatus({ status: "ERROR", retry: { deadLetter: true } }), "dead-letter");
  assert.equal(peerResponseGoalStatus({ status: "ERROR" }), "blocked");
});

test("command parser recognizes goal synthesis and verification actions", () => {
  const synthesis = parsePeerCommand("goal synthesize goal_123 --limit 3");
  assert.equal(synthesis.goalAction, "synthesize");
  assert.equal(synthesis.goalId, "goal_123");
  assert.equal(synthesis.limit, 3);

  const verify = parsePeerCommand("goal verify goal_123");
  assert.equal(verify.goalAction, "verify");
  assert.equal(verify.goalId, "goal_123");

  const send = parsePeerCommand("send worker retry-this --max-attempts 3 --retry-backoff-ms 5 --dead-letter-on-error");
  assert.equal(send.maxAttempts, 3);
  assert.equal(send.retryBackoffMs, 5);
  assert.equal(send.deadLetterOnError, true);
});
