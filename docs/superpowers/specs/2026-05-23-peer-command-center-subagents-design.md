# Peer Command Center and Subagent Adapter Design

## Goal

Make `pi-peer` easier to operate by giving users a guided setup wizard and a daily command center, while adding an optional private subagent runtime layer that builds on the protocol foundations shipped in `0.15.0`.

The core user experience should shift from remembering many commands to using a few high-level entry points:

```bash
/peer setup
/peer setup <choice>
/peer center
/peer do <intent>
/peer subrun <action>
```

Advanced commands such as `/peer goal`, `/peer org`, `/peer hive`, `/peer send`, and `/peer get` remain available and stable. The new commands are a facade over the existing protocol, not a replacement for it.

## Non-Goals

- Do not build a new TUI from scratch.
- Do not add a hard dependency on `pi-subagents`.
- Do not require users to edit `.pi/*.json` by hand for the common path.
- Do not remove existing slash commands or break existing scripts.
- Do not let private subagents satisfy independent top-level peer review gates.

## User Experience

### Setup Wizard

`/peer setup` becomes an interactive wizard entry point. Because the current extension command path is slash-command oriented, the first implementation uses reliable continuation commands instead of plain chat replies:

```bash
/peer setup
/peer setup 1
/peer setup subagents
/peer setup done
```

The wizard asks what the user wants to use the current Pi session for:

```txt
Peer setup

What do you want this session to do?

1. Coordinate other peers
2. Implement code
3. Review work
4. Research
5. Manage private subagents
6. Inspect status only

Reply with /peer setup <number>.
```

Each choice maps to a local peer role, domain, and optional capability set:

| Choice | Role | Domain | Subagents | Independent Vote |
| --- | --- | --- | --- | --- |
| Coordinate | `coordinator` | `coordination` | optional prompt | yes |
| Implement code | `implementer` | `implementation` | optional prompt | no |
| Review work | `reviewer` | `review` | optional prompt | yes |
| Research | `researcher` | `research` | optional prompt | yes |
| Manage private subagents | current role or `coordinator` | current domain or `coordination` | yes | role-dependent |
| Inspect status only | no role change unless missing | no domain change unless missing | no | unchanged |

The wizard should apply changes directly. It should not tell users to run several low-level commands unless those commands must happen in another terminal, such as starting a second Pi session with a different `PI_PEER_ID`.

The wizard writes:

- `.pi/peers.json` through existing `initPeerConfig` behavior when missing.
- `.pi/peer-org.json` through existing org helpers when missing or when assigning the local peer role.
- `.pi/peer-setup-session.json` for lightweight wizard continuation state.

`/peer setup reset` clears only the wizard state. It does not delete `.pi/peers.json` or `.pi/peer-org.json`.

### Command Center

`/peer center` is the main daily operator screen. It summarizes:

- local peer id, role, domain, and subagent capability
- configured org status
- active compatible peers grouped by role/domain
- current goal or most active open goals
- active tasks, disconnected tasks, stale claims, unresolved handoffs, and active subruns
- recommended next actions as numbered commands

Example output:

```txt
Peer command center

Local: planner-a · role coordinator · domain coordination · subagents yes
Peers: 3 active · review: reviewer-a · implementation: worker-a · research: researcher-a
Org: configured · private teams enabled · provider optional
Goals: goal_abc ready no · blockers 1 · active tasks 0 · subruns 1

Recommended:
1. /peer do resolve-handoffs
2. /peer do review goal_abc
3. /peer subrun status
4. /peer setup subagents
```

`/peer` with no arguments remains status-compatible in the first implementation, and `/peer center` is added explicitly. Any change to the no-argument default needs a separate compatibility decision.

### Intent Router

`/peer do <intent>` handles common workflows without requiring users to know the underlying command tree.

Supported first-version intents:

- `setup` -> show or continue setup wizard
- `status` -> show `/peer center`
- `start goal <objective>` -> create a goal and seed safe self-selection proposals
- `coordinate` -> claim or suggest coordination cleanup
- `review [goal-id]` -> claim or suggest a review lane
- `research [goal-id]` -> claim or suggest a research lane
- `work [goal-id]` -> show implementation-safe next action, but avoid write claims unless paths are explicit
- `resolve-handoffs` -> show unresolved handoffs and safe resolve commands
- `subagents` -> show subagent readiness and next subrun action

The intent router should be conservative. When it cannot safely mutate state, it should print one or more exact recommended commands and explain what is missing.

## Subagent Runtime Adapter

Add an optional provider-neutral private subagent module. It should not import `pi-subagents` statically.

Proposed module:

```txt
src/peers/subagents.mjs
```

Primary interface:

- `PEER_SUBAGENT_LEDGER_KIND = "subrun"`
- `normalizeSubagentRunRequest(input)`
- `normalizeSubagentRunSummary(input)`
- `resolveSubagentProvider(root, input)`
- `startPeerSubagentRun(root, input)`
- `recordPeerSubagentRunProgress(root, input)`
- `completePeerSubagentRun(root, input)`
- `cancelPeerSubagentRun(root, input)`
- `formatPeerSubagentRunResult(result)`
- `formatPeerSubagentStatus(input)`

The adapter writes compact lifecycle summaries to `.pi/peer-control-ledger.jsonl` as `kind: "subrun"`.

When a parent goal/task exists, completed subruns may attach compact evidence to the parent peer handoff via `metadata.subagentEvidence`. The evidence must remain bounded:

```js
{
  provider: "pi-subagents",
  mode: "parallel",
  childCount: 3,
  doneCount: 2,
  blockedCount: 1,
  artifactRefs: ["artifact:..."],
  summary: "Short bounded summary"
}
```

### Provider Loading

Provider resolution order:

1. explicit command flag, such as `--provider pi-subagents`
2. `.pi/peer-org.json` spawn policy provider
3. local peer capability provider
4. `"manual"` fallback

`pi-subagents` support is dynamic:

```js
const mod = await import("pi-subagents").catch(() => undefined);
```

If the provider is unavailable, the command should create a manual `subrun` record with status `blocked` or print setup guidance, not crash.

## Subrun Commands

Add `/peer subrun` with these actions:

```bash
/peer subrun status [--goal <goal-id>]
/peer subrun start <summary> [--goal <goal-id>] [--mode single|parallel|chain|async] [--provider <name>]
/peer subrun progress <subrun-id> <summary> [--artifact <ref>]
/peer subrun complete <subrun-id> <summary> [--artifact <ref>] [--done <n>] [--blocked <n>]
/peer subrun cancel <subrun-id> [reason]
```

The command should be safe if no provider is installed. A manual start should still produce a ledger entry so the command center can show that private subagent work was attempted or blocked.

## Data Flow

### Setup Flow

1. User runs `/peer setup`.
2. Extension loads runtime status, `.pi/peers.json`, `.pi/peer-org.json`, discovered peers, and setup session state.
3. Wizard prints choices.
4. User runs `/peer setup <choice>`.
5. Wizard applies local peer config and org role.
6. Wizard prints the next step and updates UI status/widget.

### Command Center Flow

1. User runs `/peer center`.
2. Extension collects runtime status, peer list, org status, goal board state, control ledger state, and setup wizard state.
3. A formatter ranks issues and actions.
4. Output includes a compact summary plus numbered recommended commands.

### Subrun Flow

1. User runs `/peer subrun start ...`.
2. Command normalizes request and resolves provider.
3. It writes a `subrun` start/progress/blocked record.
4. Provider adapter starts work if available.
5. Completion writes a terminal `subrun` record and optionally attaches compact evidence to the parent goal handoff.
6. `/peer center` and `peer_get({ id: "control" })` surface the compact state.

## File Boundaries

New files:

- `src/peers/setup-wizard.mjs` - setup state, choice mapping, wizard formatting, local config/org mutation helpers.
- `src/peers/command-center.mjs` - command center state projection, recommendation ranking, formatting.
- `src/peers/subagents.mjs` - optional provider-neutral subagent run lifecycle helpers.
- `test/peer-setup-wizard.test.mjs` - setup choice parsing, state transitions, config/org effects.
- `test/peer-command-center.test.mjs` - center projection and recommendations.
- `test/peer-subagents.test.mjs` - subrun lifecycle and no-provider fallback.

Existing files to modify:

- `src/peers/command.mjs` - parse `center`, `do`, and `subrun` commands; simplify help around primary commands.
- `extensions/pi-peer/index.ts` - wire setup wizard, center, intent router, and subrun handlers.
- `src/peers/status.mjs` - reuse or expose formatting helpers where appropriate; avoid making this file the command-center owner.
- `src/peers/control-ledger.mjs` - reuse existing `subrun` state derivation; add only small helpers if required.
- `src/peers/tool-results.mjs` - ensure compact control output remains compatible.
- `README.md` - document the simplified primary workflow.

## Error Handling

- If `.pi/peers.json` already exists, wizard should preserve existing config and only fill missing fields when safe.
- If `.pi/peer-org.json` already exists, wizard should update only the local peer entry unless the user explicitly chooses org initialization.
- If the runtime peer id is generated and no explicit id is provided, wizard should ask for `/peer setup id <peer-id>`.
- If a provider is unavailable, subrun start should return a clear blocked/manual status.
- If command-center recommendations require another terminal session, output exact `PI_PEER_ID=<id> pi` guidance.
- If no goal exists, `/peer do review`, `/peer do research`, and `/peer do work` should recommend creating or selecting a goal instead of mutating state.

## Testing Strategy

Use Node's built-in test runner. Tests should avoid real external subagent providers.

Coverage requirements:

- setup wizard choice mapping for all six choices
- setup wizard does not overwrite existing `.pi/peers.json`
- setup wizard initializes org state when missing and updates local peer role/domain
- command center renders local profile, org state, peers, goals, blocked handoffs, and subruns
- intent router maps common intents to safe existing actions or exact recommended commands
- subrun start/progress/complete/cancel records compact ledger state
- missing provider returns a blocked/manual result without throwing
- child/subagent votes still do not count as independent votes
- README examples match parser behavior

## Rollout

Implementation should land in narrow commits:

1. Command parsing and test scaffolding.
2. Setup wizard state and formatting.
3. Command center projection and formatting.
4. Intent router.
5. Subagent adapter and subrun commands.
6. Extension wiring.
7. README and full verification.

The first implementation should stay local and deterministic. Real `pi-subagents` invocation can be guarded behind dynamic import and no-provider tests.

## Open Decisions

- `/peer` with no args remains status-compatible in this implementation. Promotion to `/peer center` requires a separate compatibility decision after users have the explicit command.
- Plain chat replies such as `2` should not be required in the first implementation. Continue using `/peer setup <choice>` because it is reliable with the current extension command model.
- The adapter should not own long-running process supervision yet. It records and formats subruns, and invokes a provider only when available.
