# Peer-Private Subagent Teams Design

Date: 2026-05-23

## Purpose

Improve `pi-peer` from a flat peer messaging layer into an organizational protocol where each top-level peer acts as a domain manager. A peer can optionally use private subagents to perform its claimed work, but global coordination remains accountable to the top-level peer.

The product experience should run from one primary Pi TUI. That TUI acts as the command center while managed peer sessions run underneath it. Multiple terminal windows remain supported as a development and escape-hatch workflow, not the default user experience.

## Research Inputs

- `pi-peer` already provides roles, lanes, work keys, claims, protocol offers, closure policies, hive/self-improvement loops, and durable control-ledger recovery.
- `pi-subagents` provides optional child-agent execution: single, parallel, chain, async, forked context, worktrees, artifacts, intercom, nested status, and recursion guards. Source: https://github.com/nicobailon/pi-subagents
- Anthropic's multi-agent research system argues for a lead agent delegating to specialists, separate context windows, effort budgets, durable checkpoints, and artifact references instead of relaying full child transcripts. Source: https://www.anthropic.com/engineering/built-multi-agent-research-system
- OpenAI Agents SDK distinguishes manager-style "agents as tools" from handoffs. `pi-peer` should use the manager style: the peer owns the final answer and treats child agents as internal tools. Source: https://openai.github.io/openai-agents-python/multi_agent/
- AutoGen frames multi-agent design as message protocols and shows concurrent agents, group chat, selectors, handoffs, and result collection. Source: https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/intro.html
- LangGraph reinforces explicit shared state, reducers, checkpointable flow, bounded recursion, and durable routing. Source: https://docs.langchain.com/oss/python/langgraph/graph-api

## Chosen Model

Use peer-private subagent teams.

Top-level peers are the organizational actors. They self-select or receive protocol-routed offers for goal-board lanes. Once a peer claims a lane, it may use private subagents inside its own process/session boundary. Those child agents are not top-level peers, do not appear in `peer_list`, and do not create global goal-board claims.

The owning peer is accountable for:

- the claim and work key
- write-path boundaries
- subagent task decomposition
- child output synthesis
- final findings, votes, and handoffs
- escalation when child agents disagree or need a decision

This keeps the current flat goal-board model readable while giving capable peers more internal leverage.

## Role Setup And Domain Managers

Add an org setup layer so peers are configured as domain managers before work starts.

Initial commands:

```bash
/peer org init
/peer org status
/peer org start
/peer org stop
/peer org attach <peer-id-or-role>
/peer org role set <peer-id> --role <role> --domain <domain>
```

`/peer org init` creates `.pi/peer-org.json`. The file defines roles, domains, spawn policy, default lanes, and evidence expectations.

Example:

```json
{
  "version": 1,
  "roles": {
    "planner": {
      "domain": "Goal decomposition, sequencing, and scope control",
      "defaultLanes": ["coordination", "planning"],
      "canSpawn": ["planner", "oracle", "scout"],
      "expectedEvidence": ["plan", "risk-summary"],
      "countsForIndependentVote": false
    },
    "researcher": {
      "domain": "External facts, citations, source quality, and uncertainty",
      "defaultLanes": ["research"],
      "canSpawn": ["researcher", "scout", "oracle"],
      "expectedEvidence": ["citations", "fact-checks", "limitations"],
      "countsForIndependentVote": false
    },
    "implementer": {
      "domain": "Code changes, write claims, worktree hygiene, and verification",
      "defaultLanes": ["implementation"],
      "canSpawn": ["scout", "worker", "reviewer"],
      "expectedEvidence": ["files-changed", "verification", "risks"],
      "countsForIndependentVote": false
    },
    "reviewer": {
      "domain": "Independent critique, test gaps, risk calls, and closure votes",
      "defaultLanes": ["review"],
      "canSpawn": ["reviewer", "oracle"],
      "expectedEvidence": ["findings", "vote", "confidence"],
      "countsForIndependentVote": true
    },
    "coordinator": {
      "domain": "Stale claims, unresolved handoffs, board hygiene, and close readiness",
      "defaultLanes": ["coordination"],
      "canSpawn": ["scout", "oracle"],
      "expectedEvidence": ["resolved-blockers", "closure-summary"],
      "countsForIndependentVote": false
    }
  }
}
```

Peers bind themselves to a role and domain during setup:

```bash
/peer setup --id reviewer-a --role reviewer --domain quality
/peer setup --id worker2 --role implementer --domain code
```

The org charter guides routing and prompting but does not create a hard hierarchy. Peers still self-select work through lanes, claims, and work keys.

## One-TUI Runtime

The intended user experience is one primary Pi TUI:

```text
Pi TUI
  -> pi-peer extension
      -> org supervisor runtime
          -> managed planner peer
          -> managed implementer peer
          -> managed reviewer peer
              -> optional private subagents
```

The main TUI should show compact org state: peers, roles, current claims, active work, blockers, child-run summaries, and attach commands. It must not ingest every peer transcript into the main conversation. Each managed peer keeps its own context, message stream, and optional child subagent sessions.

Multiple manually-opened Pi sessions remain valid. They are useful for debugging, experiments, and explicit human-supervised peers. The org supervisor should treat them as discovered external peers.

## Extension-First Implementation

Build this as a Pi extension, not a custom TUI.

Reasons:

- `pi-peer` already ships as a TypeScript Pi extension.
- Pi already provides command registration, tool registration, message rendering, lifecycle hooks, footer/status widgets, cwd/session access, and package install behavior.
- `pi-subagents` is also a Pi extension, so optional integration can happen through extension/tool capability checks.
- A custom TUI would duplicate session lifecycle, model config, auth/env behavior, tool rendering, prompt boundaries, and dashboard primitives.

A separate UI can be considered later as a monitor, but the protocol and supervisor should live in the extension first.

## Capability Advertisement

Peer descriptors should advertise optional orchestration capability when available:

```json
{
  "capabilities": {
    "orchestration": {
      "subagents": true,
      "provider": "pi-subagents",
      "modes": ["single", "parallel", "chain", "async"],
      "maxDepth": 1,
      "maxConcurrency": 4,
      "worktree": true,
      "intercom": true
    }
  }
}
```

If the capability is absent or false, the peer remains a normal single-agent peer. `pi-peer` must not require `pi-subagents` to be installed.

Detection should be local and conservative:

- detect installed `pi-subagents` extension/tool support
- read project/user settings only if available
- advertise only modes that are actually usable
- avoid advertising write/worktree support unless configured and safe

## Goal-Board Evidence

The goal board remains the human-facing coordination layer. Child agent details should be summarized under the owning peer's normal events.

Example handoff metadata:

```json
{
  "subagentEvidence": {
    "provider": "pi-subagents",
    "runId": "abc123",
    "mode": "parallel",
    "childCount": 3,
    "artifactRefs": [".../review-summary.md"],
    "acceptedFindings": 2,
    "rejectedFindings": 1,
    "children": [
      {
        "agent": "reviewer",
        "role": "correctness",
        "status": "completed",
        "summary": "Found missing edge-case test"
      },
      {
        "agent": "oracle",
        "role": "risk",
        "status": "completed",
        "summary": "Recommended narrower protocol boundary"
      }
    ]
  }
}
```

Child-generated review does not count as independent top-level peer review. Independent review gates are satisfied only by distinct top-level peers.

## Control-Ledger Records

Add compact `subrun` records to `.pi/peer-control-ledger.jsonl`.

Start record:

```json
{
  "kind": "subrun",
  "action": "started",
  "status": "running",
  "goalId": "goal_123",
  "workKey": "goal_123|review|...",
  "peerId": "worker2",
  "summary": "worker2 started private review team",
  "metadata": {
    "provider": "pi-subagents",
    "runId": "abc123",
    "mode": "parallel",
    "children": [
      { "agent": "reviewer", "role": "correctness" },
      { "agent": "reviewer", "role": "tests" },
      { "agent": "oracle", "role": "risk" }
    ]
  }
}
```

Completion record:

```json
{
  "kind": "subrun",
  "action": "completed",
  "status": "done",
  "goalId": "goal_123",
  "workKey": "goal_123|review|...",
  "peerId": "worker2",
  "summary": "3 child reviewers completed; 2 findings accepted, 1 rejected",
  "metadata": {
    "provider": "pi-subagents",
    "runId": "abc123",
    "artifactRefs": [".../review-summary.md"]
  }
}
```

Supported statuses:

- `running`
- `done`
- `partial`
- `blocked`
- `cancelled`
- `error`

The control ledger answers "what happened inside the owning peer?" The goal board answers "what conclusion did the owning peer bring back to the organization?"

## Scheduling And Routing

The scout and idle-offer scheduler should use role/domain/capability as hints, not hard assignments.

Routing guidance:

- `research` lanes prefer researcher peers and subagent-capable peers with parallel support.
- `review` lanes prefer reviewer peers and subagent-capable peers with parallel review support.
- `implementation` lanes prefer implementer peers with write access; prefer worktree-capable peers for high-risk or parallel work.
- `coordination` lanes prefer planner/coordinator peers and should avoid subagent fanout unless the task is broad or unclear.
- closure-policy gaps can prefer subagent-capable reviewers for richer evidence, but independent vote requirements still require distinct top-level peers.

After claiming a lane, a peer can choose its private execution pattern:

- `single`: one scout/oracle/reviewer for a second opinion
- `parallel`: multiple reviewers or researchers against distinct angles
- `chain`: scout -> planner -> worker -> reviewer
- `async`: background research or review with status summarized by the owning peer

## Safety Rules

- `pi-subagents` remains optional.
- Private child agents inherit the parent peer's claim boundary.
- Children do not create top-level peer claims.
- Children do not post directly to the shared goal board in the initial design.
- Parent peer is responsible for final handoff sections and evidence.
- Child disagreement must be summarized, not hidden.
- Child review does not satisfy independent top-level review gates.
- Default nesting depth is one: peer -> child.
- Deeper nesting requires explicit capability and config.
- Full child transcripts remain in artifacts/session files.
- Artifact refs must be local, redacted, and safe to inspect.
- No child may broaden write scope beyond the parent claim.

## Compatibility

Protocol version can remain `1` while this is optional metadata and existing peers ignore unknown fields.

Bump protocol version only if a later stage adds required message types or mandatory descriptor fields.

Existing peers remain compatible because:

- missing `capabilities.orchestration` means no private-subagent support
- existing goal-board event types still carry the final evidence
- unknown event metadata is ignored by older code
- existing closure policies continue to judge top-level peer evidence

## Implementation Stages

1. **Org charter and role setup**
   - Add `.pi/peer-org.json` load/save/format helpers.
   - Add `/peer org init|status|role set`.
   - Extend setup/status output with role/domain manager language.

2. **Passive capability metadata**
   - Extend peer descriptors with optional `capabilities.orchestration`.
   - Detect available `pi-subagents` support conservatively.
   - Show advertised orchestration capability in `peer_list`, status, and doctor output.

3. **Subrun ledger summaries**
   - Extend control-ledger normalization and derived state with `kind: "subrun"`.
   - Add formatting in `peer_get({ id: "control" })`.
   - Add tests for started/done/partial/blocked/error records.

4. **Handoff evidence support**
   - Normalize and compact `metadata.subagentEvidence` on handoff/finding events.
   - Render compact child evidence in goal views.
   - Ensure child evidence does not count as independent top-level vote evidence.

5. **Optional adapter**
   - Add a narrow adapter that can request `pi-subagents` runs when available.
   - Start with explicit invocation from peer prompts or commands.
   - Later allow scheduler prompts to suggest internal patterns for subagent-capable peers.

6. **One-TUI org supervisor**
   - Add `/peer org start|stop|attach`.
   - Manage peer processes/sessions from the extension where Pi APIs allow it.
   - Render compact org dashboard in existing Pi UI.
   - Preserve manual multi-TUI peers as discovered external peers.

## Testing Strategy

Unit tests:

- org charter normalization and defaults
- peer role/domain binding
- orchestration capability normalization
- control-ledger `subrun` state derivation
- goal-board rendering of subagent evidence
- independent vote exclusion for child evidence
- scheduler preference scoring for role/domain/capability hints

Integration-style tests:

- existing peers without subagent metadata still pass all status/list/scout flows
- subagent-capable peer receives a preferred review/research offer
- child failure creates `partial` evidence but does not corrupt the parent claim
- org setup creates stable files without overwriting existing user config

Manual checks:

- `/peer org init`
- `/peer setup --role reviewer --domain quality`
- `/peer status`
- `/peer list`
- `/peer get control`
- a goal with parent handoff metadata containing child evidence

## Open Decisions

- Exact process/session API for `/peer org start` depends on Pi extension capabilities. If Pi cannot spawn managed peer sessions directly, stage 6 should create copyable commands first and add managed spawning when the API supports it.
- The first adapter may only record evidence from explicit peer-side subagent use. Automatic subagent launch from protocol offers should wait until detection, safety, and status reporting are proven.

## Approval Summary

The approved design direction is:

- peer-private subagent teams
- top-level peers as domain managers
- optional `pi-subagents` integration
- one primary Pi TUI as command center
- TypeScript Pi extension implementation, not a new TUI
- compact child evidence in goal-board events
- durable nested lifecycle summaries in the control ledger
