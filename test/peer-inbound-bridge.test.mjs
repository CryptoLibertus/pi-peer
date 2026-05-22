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

test("inbound bridge records redacted diagnostics when agent_end has no final assistant text", async () => {
  const bridge = createInboundPromptBridge({
    pi: { sendMessage: () => {} },
    responseTimeoutMs: 60_000,
  });

  const responsePromise = bridge.handleEnvelope(envelope("msg_empty_final"));
  bridge.handleAgentEnd({
    willRetry: false,
    messages: [
      { role: "user", content: "private user prompt should not be echoed" },
      { role: "assistant", stopReason: "tool_use", content: [{ type: "tool_use", input: "secret token abc123" }] },
    ],
  });
  const response = await responsePromise;

  assert.equal(response.status, "ERROR");
  assert.equal(response.summary, "agent_end did not include final assistant text");
  assert.equal(response.diagnostics.willRetry, false);
  assert.deepEqual(response.diagnostics.messages.roles, ["user", "assistant"]);
  assert.equal(response.diagnostics.messages.lastAssistant.stopReason, "tool_use");
  assert.deepEqual(response.diagnostics.messages.lastAssistant.content.blockTypes, ["tool_use"]);
  assert.equal(JSON.stringify(response.diagnostics).includes("private user prompt"), false);
  assert.equal(JSON.stringify(response.diagnostics).includes("secret token"), false);
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

test("inbound bridge captures handoff evidence from markdown headings", async () => {
  const bridge = createInboundPromptBridge({
    pi: { sendMessage: () => {} },
    responseTimeoutMs: 60_000,
  });

  const responsePromise = bridge.handleEnvelope(envelope("msg_markdown_handoff"));
  const finalText = `## Status

done

## Files changed

none

## Verification

\`npm test\` — exit 0

## Blockers/risks

none

## Safe for review

yes

## Citations/Sources

README.md

## Fact-checks

heading parser regression covered

## Limitations

repo-local only

## Confidence

93%`;
  bridge.handleAgentEnd({ finalAssistantText: finalText });
  const response = await responsePromise;

  assert.equal(response.status, "OK");
  assert.equal(response.handoffEvidence.complete, true);
  assert.equal(response.handoffEvidence.status, "done");
  assert.deepEqual(response.handoffEvidence.filesChanged, ["none"]);
  assert.deepEqual(response.handoffEvidence.verification, [{ command: "npm test", exitStatus: 0, raw: "`npm test` — exit 0" }]);
  assert.deepEqual(response.handoffEvidence.blockersRisks, ["none"]);
  assert.equal(response.handoffEvidence.safeForReview, true);
  assert.deepEqual(response.handoffEvidence.citations, ["README.md"]);
  assert.deepEqual(response.handoffEvidence.factChecks, ["heading parser regression covered"]);
  assert.deepEqual(response.handoffEvidence.limitations, ["repo-local only"]);
  assert.equal(response.handoffEvidence.confidence, 0.93);
});

test("inbound bridge captures optional research quality evidence", async () => {
  const sent = [];
  const bridge = createInboundPromptBridge({
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    responseTimeoutMs: 60_000,
  });

  const responsePromise = bridge.handleEnvelope(envelope("msg_quality"));
  const finalText = `Status: done
Files changed: none
Verification: not run with reason: research synthesis only
Blockers/risks: none
Safe for review: yes
Citations: README.md; test/peer-goal-board.test.mjs
Fact-checks: claim "closure gates inspect evidence" verified against goal-board tests
Limitations: repo-local evidence only
Confidence: 82%`;
  bridge.handleAgentEnd({ finalAssistantText: finalText });
  const response = await responsePromise;

  assert.equal(response.handoffEvidence.complete, true);
  assert.deepEqual(response.handoffEvidence.citations, ["README.md", "test/peer-goal-board.test.mjs"]);
  assert.deepEqual(response.handoffEvidence.factChecks, ["claim \"closure gates inspect evidence\" verified against goal-board tests"]);
  assert.deepEqual(response.handoffEvidence.limitations, ["repo-local evidence only"]);
  assert.equal(response.handoffEvidence.confidence, 0.82);

  const invalidConfidence = createInboundPromptBridge({
    pi: { sendMessage: () => {} },
    responseTimeoutMs: 60_000,
  });
  const invalidPromise = invalidConfidence.handleEnvelope(envelope("msg_invalid_quality"));
  invalidConfidence.handleAgentEnd({ finalAssistantText: finalText.replace("Confidence: 82%", "Confidence: 150%") });
  const invalidResponse = await invalidPromise;
  assert.equal(invalidResponse.handoffEvidence.confidence, undefined);

  const negativeConfidence = createInboundPromptBridge({
    pi: { sendMessage: () => {} },
    responseTimeoutMs: 60_000,
  });
  const negativePromise = negativeConfidence.handleEnvelope(envelope("msg_negative_quality"));
  negativeConfidence.handleAgentEnd({ finalAssistantText: finalText.replace("Confidence: 82%", "Confidence: -0.1") });
  const negativeResponse = await negativePromise;
  assert.equal(negativeResponse.handoffEvidence.confidence, undefined);
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
