import test from "node:test";
import assert from "node:assert/strict";

import { createInboundPromptBridge } from "../src/peers/inbound-bridge.mjs";

function envelope(id = "msg_1") {
  return {
    id,
    protocol: "pi-peer",
    type: "message.request",
    conversationId: "conv_1",
    source: { peerId: "planner", transport: "coms" },
    target: { peerId: "worker", transport: "coms" },
    body: { intent: "task", prompt: "Do the work" },
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
