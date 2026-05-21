import test from "node:test";
import assert from "node:assert/strict";

import { createInboundPromptBridge } from "../src/peers/inbound-bridge.mjs";

function envelope(id = "msg_1", body = {}) {
  return {
    id,
    protocol: "pi-peer",
    type: "message.request",
    conversationId: "conv_1",
    source: { peerId: "planner", transport: "coms" },
    target: { peerId: "worker", transport: "coms" },
    body: { intent: "task", prompt: "Do the work", ...body },
  };
}

function cancellableContext(events = []) {
  let cancelListener;
  return {
    markQueued(input) { events.push({ type: "queued", input }); },
    markActive() { events.push({ type: "active" }); },
    onCancel(listener) {
      cancelListener = listener;
      return () => {
        if (cancelListener === listener) cancelListener = undefined;
      };
    },
    cancel(reason = "cancelled by test") {
      cancelListener?.({ reason });
    },
  };
}

test("inbound bridge initial activation and idle nudge use triggerTurn followUp", async () => {
  const sent = [];
  const bridge = createInboundPromptBridge({
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    responseTimeoutMs: 60_000,
    activationNudgeCooldownMs: 0,
  });

  const responsePromise = bridge.handleEnvelope(envelope());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.triggerTurn, true);
  assert.equal(sent[0].options.deliverAs, "followUp");
  assert.equal(sent[0].message.details.activationReason, "initial");

  const nudged = bridge.nudgeActive({ reason: "test", cooldownMs: 0 });
  assert.equal(nudged.ok, true);
  assert.equal(nudged.activationAttempts, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].message.details.activationReason, "test");

  bridge.handleAgentEnd({ finalAssistantText: "done" });
  const response = await responsePromise;
  assert.equal(response.status, "OK");
  assert.equal(bridge.pendingCount(), 0);
});

test("inbound bridge nudge respects cooldown and queue remains behind active", async () => {
  const sent = [];
  const queued = [];
  const bridge = createInboundPromptBridge({
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    responseTimeoutMs: 60_000,
    activationNudgeCooldownMs: 60_000,
  });

  const first = bridge.handleEnvelope(envelope("msg_1"));
  const second = bridge.handleEnvelope(envelope("msg_2"), { markQueued: () => queued.push("msg_2") });
  assert.equal(sent.length, 1);
  assert.equal(queued.length, 1);
  assert.equal(bridge.pendingCount(), 2);

  const nudged = bridge.nudgeActive({ reason: "too-soon" });
  assert.equal(nudged.ok, false);
  assert.equal(nudged.reason, "inbound activation nudge cooldown");
  assert.equal(sent.length, 1);

  bridge.handleAgentEnd({ finalAssistantText: "first done" });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].message.envelope.messageId, "msg_2");
  bridge.handleAgentEnd({ finalAssistantText: "second done" });

  assert.equal((await first).status, "OK");
  assert.equal((await second).status, "OK");
});

test("inbound bridge cancels queued entries without disturbing the active task", async () => {
  const sent = [];
  const queuedEvents = [];
  const bridge = createInboundPromptBridge({
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    responseTimeoutMs: 60_000,
  });

  const active = bridge.handleEnvelope(envelope("msg_active"), cancellableContext());
  const queuedContext = cancellableContext(queuedEvents);
  const queued = bridge.handleEnvelope(envelope("msg_queued"), queuedContext);
  assert.equal(bridge.pendingCount(), 2);
  assert.deepEqual(queuedEvents[0].input, { queuedPosition: 1, queueLength: 1, priority: "P1" });

  queuedContext.cancel("not needed anymore");
  assert.equal((await queued).status, "CANCELLED");
  assert.equal(bridge.pendingCount(), 1);
  assert.equal(sent.length, 1);

  bridge.handleAgentEnd({ finalAssistantText: "active done" });
  assert.equal((await active).status, "OK");
  assert.equal(bridge.pendingCount(), 0);
});

test("inbound bridge marks active cancellation without settling or activating the next task", async () => {
  const sent = [];
  const bridge = createInboundPromptBridge({
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    responseTimeoutMs: 60_000,
  });

  const activeContext = cancellableContext();
  const active = bridge.handleEnvelope(envelope("msg_active"), activeContext);
  const queued = bridge.handleEnvelope(envelope("msg_queued"), cancellableContext());

  activeContext.cancel("stop active");
  assert.equal(bridge.activeState().messageId, "msg_active");
  assert.equal(bridge.activeState().cancelling, true);
  assert.equal(bridge.activeState().cancelReason, "stop active");
  assert.equal(sent.length, 1);
  assert.equal(await Promise.race([active.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("pending"), 10))]), "pending");

  bridge.handleAgentEnd({ finalAssistantText: "active done" });
  assert.equal((await active).status, "CANCELLED");
  assert.equal(sent[1].message.envelope.messageId, "msg_queued");
  bridge.handleAgentEnd({ finalAssistantText: "queued done" });
  assert.equal((await queued).status, "OK");
});

test("inbound bridge captures structured final handoff evidence without changing final text", async () => {
  const sent = [];
  const bridge = createInboundPromptBridge({
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    responseTimeoutMs: 60_000,
  });

  const responsePromise = bridge.handleEnvelope(envelope("msg_handoff"));
  const finalText = `Status: done
Files changed: src/peers/inbound-bridge.mjs, test/peer-inbound-bridge.test.mjs
Verification: \`node --test test/peer-inbound-bridge.test.mjs\` — exit 0
Blockers/risks: none
Safe for review: yes`;
  bridge.handleAgentEnd({ finalAssistantText: finalText });
  const response = await responsePromise;

  assert.equal(response.status, "OK");
  assert.equal(response.finalAssistantMessage, finalText);
  assert.equal(response.handoffEvidence.complete, true);
  assert.equal(response.handoffEvidence.status, "done");
  assert.deepEqual(response.handoffEvidence.filesChanged, ["src/peers/inbound-bridge.mjs", "test/peer-inbound-bridge.test.mjs"]);
  assert.deepEqual(response.handoffEvidence.verification, [{
    command: "node --test test/peer-inbound-bridge.test.mjs",
    exitStatus: 0,
    raw: "`node --test test/peer-inbound-bridge.test.mjs` — exit 0",
  }]);
  assert.deepEqual(response.handoffEvidence.blockersRisks, ["none"]);
  assert.equal(response.handoffEvidence.safeForReview, true);
});

test("inbound bridge uses bounded priority ordering for queued work", async () => {
  const sent = [];
  const bridge = createInboundPromptBridge({
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    responseTimeoutMs: 60_000,
  });

  const active = bridge.handleEnvelope(envelope("msg_active"), cancellableContext());
  const low = bridge.handleEnvelope(envelope("msg_low", { priority: "P2" }), cancellableContext());
  const urgent = bridge.handleEnvelope(envelope("msg_urgent", { priority: "P0" }), cancellableContext());
  assert.equal(bridge.activeState().queued[0].messageId, "msg_urgent");
  assert.equal(bridge.activeState().queued[1].messageId, "msg_low");

  bridge.handleAgentEnd({ finalAssistantText: "active done" });
  assert.equal(sent[1].message.envelope.messageId, "msg_urgent");
  bridge.handleAgentEnd({ finalAssistantText: "urgent done" });
  assert.equal(sent[2].message.envelope.messageId, "msg_low");
  bridge.handleAgentEnd({ finalAssistantText: "low done" });

  assert.equal((await active).status, "OK");
  assert.equal((await urgent).status, "OK");
  assert.equal((await low).status, "OK");
});
