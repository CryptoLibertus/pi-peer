import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePeerHandoffEvidence,
  peerGetToolResult,
  peerSendResponseToolResult,
} from "../src/peers/tool-results.mjs";

test("peer_get defaults to compact goal output without raw event dump", () => {
  const goal = {
    id: "goal_big",
    objective: "A".repeat(400),
    status: "open",
    events: Array.from({ length: 40 }, (_, index) => ({ id: `evt_${index}`, type: "note", peerId: "worker", summary: `event ${index} ${"x".repeat(100)}` })),
    activeClaims: [{ id: "claim_1", peerId: "worker", summary: "Claim", mode: "read" }],
    activeTasks: [],
    staleClaims: [],
    unresolvedTaskHandoffs: [],
    openProposals: [],
    openWorkItems: [],
    blockingObjections: [],
    currentVotes: [],
    passingVotes: [],
    failedVotes: [],
  };

  const result = peerGetToolResult("goal_big", "goal", goal);
  assert.equal(result.details.view, "compact");
  assert.equal(result.details.compacted, true);
  assert.equal(result.details.rawAvailable, true);
  assert.equal(result.details.value.id, "goal_big");
  assert.equal(result.details.value.counts.events, 40);
  assert.equal(result.details.value.events, undefined);
  assert.ok(result.details.value.recentEvents.length <= 12);
  assert.doesNotMatch(result.content[0].text, /"evt_0"/);
});

test("peer_get full view preserves raw goal events", () => {
  const goal = { id: "goal_raw", events: [{ id: "evt_1", type: "note", summary: "raw" }] };
  const result = peerGetToolResult("goal_raw", "goal", goal, { view: "full" });
  assert.equal(result.details.view, "full");
  assert.equal(result.details.compacted, false);
  assert.deepEqual(result.details.value.events, goal.events);
  assert.match(result.content[0].text, /"events"/);
});

test("peer_get compact message omits full prompt and final assistant body", () => {
  const longPrompt = "prompt ".repeat(200);
  const longFinal = "final ".repeat(200);
  const message = {
    messageId: "msg_1",
    conversationId: "conv_1",
    peerId: "worker",
    status: "responded",
    request: { body: { intent: "review", prompt: longPrompt, metadata: { goalId: "goal_1", workKey: "review:1" } } },
    response: { status: "OK", finalAssistantMessage: longFinal },
    events: [{ type: "queued", summary: "queued" }],
  };

  const result = peerGetToolResult("msg_1", "message", message);
  assert.equal(result.details.value.prompt, undefined);
  assert.equal(result.details.value.response, undefined);
  assert.equal(result.details.value.finalAssistantTextPresent, true);
  assert.equal(result.details.value.finalAssistantTextLength, longFinal.trim().length);
  assert.match(result.details.value.promptPreview, /^prompt prompt/);
  assert.ok(result.details.value.promptPreview.length < longPrompt.length);
  assert.ok(result.details.value.finalAssistantPreview.length < longFinal.length);
});

test("peer_get compact message exposes missing final assistant text code without raw body", () => {
  const message = {
    messageId: "msg_empty",
    conversationId: "conv_1",
    peerId: "worker",
    status: "responded",
    request: { body: { intent: "review", prompt: "private prompt body" } },
    response: {
      status: "ERROR",
      summary: "agent_end did not include final assistant text",
      code: "PI_PEER_AGENT_END_MISSING_FINAL_ASSISTANT_TEXT",
      error: {
        code: "PI_PEER_AGENT_END_MISSING_FINAL_ASSISTANT_TEXT",
        message: "agent_end did not include final assistant text",
      },
      finalAssistantTextPresent: false,
      finalAssistantTextLength: 0,
    },
    events: [],
  };

  const result = peerGetToolResult("msg_empty", "message", message);
  assert.equal(result.details.value.responseStatus, "ERROR");
  assert.equal(result.details.value.responseCode, "PI_PEER_AGENT_END_MISSING_FINAL_ASSISTANT_TEXT");
  assert.equal(result.details.value.finalAssistantTextPresent, false);
  assert.equal(result.details.value.finalAssistantTextLength, 0);
  assert.equal(result.details.value.finalAssistantPreview, undefined);
  assert.equal(result.details.value.response, undefined);
});

test("peer_send awaited result surfaces final assistant text validity metadata", () => {
  const handle = { messageId: "msg_empty", conversationId: "conv_1", peerId: "worker" };
  const response = {
    status: "ERROR",
    summary: "agent_end did not include final assistant text",
    code: "PI_PEER_AGENT_END_MISSING_FINAL_ASSISTANT_TEXT",
    finalAssistantTextPresent: false,
    finalAssistantTextLength: 0,
  };

  const result = peerSendResponseToolResult(handle, response);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.finalAssistantTextPresent, false);
  assert.equal(result.details.finalAssistantTextLength, 0);
  assert.equal(result.details.response.code, "PI_PEER_AGENT_END_MISSING_FINAL_ASSISTANT_TEXT");
  assert.match(result.content[0].text, /PI_PEER_AGENT_END_MISSING_FINAL_ASSISTANT_TEXT/);
});

test("peer_get compact control output preserves active subrun fields", () => {
  const result = peerGetToolResult("control", "control", {
    records: 3,
    activeTasks: [],
    disconnectedTasks: [],
    completedTasks: [],
    activeHiveRuns: [],
    hiveRuns: [],
    subruns: [{ subrunId: "subrun_1" }],
    completedSubruns: [],
    activeSubruns: [{
      subrunId: "subrun_1",
      parentPeerId: "coordinator",
      provider: "codex",
      mode: "review",
      goalId: "goal_1",
      workKey: "review:1",
      status: "progress",
      childCount: 3,
      completedCount: 1,
      blockedCount: 0,
      artifactRefs: ["artifact:first", "artifact:second"],
      summary: "Checking subrun progress",
      updatedAt: "2026-01-01T00:00:01.000Z",
      completedAt: undefined,
    }],
  });

  assert.deepEqual(result.details.value.activeSubruns, [{
    subrunId: "subrun_1",
    parentPeerId: "coordinator",
    provider: "codex",
    mode: "review",
    goalId: "goal_1",
    workKey: "review:1",
    status: "progress",
    childCount: 3,
    completedCount: 1,
    blockedCount: 0,
    artifactRefs: ["artifact:first", "artifact:second"],
    summary: "Checking subrun progress",
    updatedAt: "2026-01-01T00:00:01.000Z",
  }]);
});

test("handoff evidence parser accepts plain section headings", () => {
  const evidence = parsePeerHandoffEvidence(`Status
Done

Files changed
none

Verification
npm test — exit 0

Blockers/risks
none

Safe for review
yes`);

  assert.equal(evidence.complete, true);
  assert.equal(evidence.status, "done");
  assert.deepEqual(evidence.filesChanged, ["none"]);
  assert.deepEqual(evidence.verification, [{ command: "npm test", exitStatus: 0, raw: "npm test — exit 0" }]);
  assert.deepEqual(evidence.blockersRisks, ["none"]);
  assert.equal(evidence.safeForReview, true);
});

test("peer_get missing value behavior is unchanged", () => {
  const result = peerGetToolResult("missing", "missing", undefined);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.found, false);
  assert.equal(result.content[0].text, "No peer state found for missing");
});
