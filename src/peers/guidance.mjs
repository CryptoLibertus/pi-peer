export const PEER_TOOL_NAMES = Object.freeze({
  list: "peer_list",
  send: "peer_send",
  get: "peer_get",
  await: "peer_await",
  progress: "peer_progress",
  context: "peer_context",
});

const PEER_LIST_GUIDANCE = "Use peer_list to discover configured or discovered local peers before peer_send; do not invent peer ids, and avoid peers marked current/self unless intentionally testing self-targeting.";
const PEER_SEND_GUIDANCE = "Use peer_send to send a prompt-first message to a peer; for long-running tasks pass goalId plus claimedPaths to create a durable goal-board claim, and if await is false or waiting times out, save the returned messageId and conversationId.";
const PEER_AWAIT_GUIDANCE = "Use peer_await with messageId values from queued or timed-out peer_send calls to read final assistant replies.";
const PEER_GET_GUIDANCE = "Use peer_get to inspect a peer, message, conversation, runtime summary, active tasks via 'tasks', fan-out suggestions via 'fanout', or redacted audit state by id.";
const PEER_PROGRESS_GUIDANCE = "Use peer_progress from inside an inbound long-running peer task to send structured checkpoint updates before the final handoff.";
const PEER_CONTEXT_GUIDANCE = "Use peer_context when coordinating long-running peer work to inspect local context usage/pressure before deciding to compact, summarize, or delegate.";
const PEER_FANOUT_GUIDANCE = "Fan-out gate: for multi-part, long-running, or implementation-plus-review work, call peer_list and use a goal board plus peer_send for research/review/QA lanes unless the user explicitly says to work solo. For emergent self-organization tests, create/reuse a peer goal and let peers inspect scout suggestions or claim lane-specific work keys instead of over-assigning every lane; if you skip fan-out, state the reason in the final response.";

export const PEER_INBOUND_FINAL_RESPONSE_GUIDANCE = "For inbound peer asks, answer the inbound ask in your final assistant response; that final assistant response is returned to the requesting peer. For write-capable task intents, end with a concise handoff: status, files changed, verification commands with exit status, and blockers.";

export const PEER_COMMUNICATION_GUIDANCE = Object.freeze([
  PEER_LIST_GUIDANCE,
  PEER_SEND_GUIDANCE,
  PEER_AWAIT_GUIDANCE,
  PEER_GET_GUIDANCE,
  PEER_PROGRESS_GUIDANCE,
  PEER_CONTEXT_GUIDANCE,
  PEER_FANOUT_GUIDANCE,
  PEER_INBOUND_FINAL_RESPONSE_GUIDANCE,
]);

export const PEER_TOOL_PROMPT_GUIDELINES = Object.freeze({
  [PEER_TOOL_NAMES.list]: Object.freeze([PEER_LIST_GUIDANCE]),
  [PEER_TOOL_NAMES.send]: Object.freeze([
    PEER_LIST_GUIDANCE,
    PEER_SEND_GUIDANCE,
    "peer_send awaited results contain the target peer's final assistant response plus peerIdentity metadata when available; use peer_await later when peer_send returns queued or await_timeout.",
    "For long-running task peers, inspect active work with peer_get id 'tasks' and require final handoff summaries.",
    PEER_FANOUT_GUIDANCE,
    "Do not send planner work to the current planner peer; self-targeting requires explicit allowSelf and is usually only for diagnostics.",
  ]),
  [PEER_TOOL_NAMES.await]: Object.freeze([PEER_AWAIT_GUIDANCE]),
  [PEER_TOOL_NAMES.get]: Object.freeze([PEER_GET_GUIDANCE]),
  [PEER_TOOL_NAMES.progress]: Object.freeze([PEER_PROGRESS_GUIDANCE, PEER_INBOUND_FINAL_RESPONSE_GUIDANCE]),
  [PEER_TOOL_NAMES.context]: Object.freeze([PEER_CONTEXT_GUIDANCE]),
});

export function renderPeerCommunicationGuidance() {
  return PEER_COMMUNICATION_GUIDANCE.map((line) => `- ${line}`).join("\n");
}
