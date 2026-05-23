# Peer Command Center And Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided `/peer setup <choice>` wizard, `/peer center`, `/peer do <intent>`, and optional `/peer subrun` lifecycle commands without breaking existing peer protocol commands.

**Architecture:** Keep the feature as an additive facade over the existing peer protocol. Setup writes safe local config and org role state; command center projects existing runtime/org/goal/control-ledger state; subruns append compact `kind: "subrun"` records and use a dynamic provider boundary so `pi-subagents` is optional.

**Tech Stack:** Node.js ESM modules in `src/peers/*.mjs`, TypeScript Pi extension wiring in `extensions/pi-peer/index.ts`, built-in Node test runner via `node --test`.

---

## File Structure

Create:

- `src/peers/setup-wizard.mjs` - setup session state, six choice mappings, safe `.pi/peers.json` fill-in, org role assignment, setup output formatting.
- `src/peers/command-center.mjs` - command-center projection, recommendations, `/peer do` intent routing helpers, text formatters.
- `src/peers/subagents.mjs` - provider-neutral private subagent lifecycle helpers and subrun formatters.
- `test/peer-setup-wizard.test.mjs` - setup choice parsing, state transitions, config preservation, org role updates.
- `test/peer-command-center.test.mjs` - center projection, recommendations, conservative intent routing.
- `test/peer-subagents.test.mjs` - subrun lifecycle, no-provider fallback, compact evidence.

Modify:

- `src/peers/command.mjs` - parse `center`, wizard-style `setup`, `do`, and `subrun`; update help.
- `extensions/pi-peer/index.ts` - route new parsed commands to the new modules and refresh runtime/UI.
- `src/peers/control-ledger.mjs` - only add small exported helpers if needed by `subagents.mjs`; keep existing derivation behavior intact.
- `src/peers/tool-results.mjs` - only touch if `peer_get({ id: "control" })` output omits data already present in `derivePeerControlState`.
- `README.md` - document the simplified primary workflow.
- `test/peer-command.test.mjs` - parser and help coverage for the new facade commands.

Keep untouched unless required by a failing test:

- `src/peers/goal-board.mjs` already supports `metadata.subagentEvidence` and rejects child/subagent votes as independent top-level votes.
- `src/peers/org.mjs` already models top-level peers as domain managers with private subagent teams.
- `src/peers/status.mjs` can be reused, but the new command center should live in `command-center.mjs`.

## Implementation Tasks

### Task 1: Parser And Help

**Files:**

- Modify: `src/peers/command.mjs`
- Modify: `test/peer-command.test.mjs`

- [ ] **Step 1: Write failing parser tests**

Append these tests to `test/peer-command.test.mjs`:

```js
test("parses command-center and setup wizard commands", () => {
  assert.equal(parsePeerCommand("center").subcommand, "center");

  const show = parsePeerCommand("setup");
  assert.equal(show.subcommand, "setup");
  assert.equal(show.setupAction, "show");
  assert.equal(show.setupWizard, true);

  const choice = parsePeerCommand("setup 1");
  assert.equal(choice.subcommand, "setup");
  assert.equal(choice.setupAction, "choice");
  assert.equal(choice.setupChoice, "coordinate");

  const subagents = parsePeerCommand("setup subagents");
  assert.equal(subagents.setupAction, "choice");
  assert.equal(subagents.setupChoice, "subagents");

  const reset = parsePeerCommand("setup reset");
  assert.equal(reset.setupAction, "reset");

  const id = parsePeerCommand("setup id planner-a");
  assert.equal(id.setupAction, "id");
  assert.equal(id.localPeerId, "planner-a");
});

test("setup flags preserve legacy setup/init behavior", () => {
  const parsed = parsePeerCommand("setup --id planner-a --role planner --domain protocol --subagents");
  assert.equal(parsed.subcommand, "setup");
  assert.equal(parsed.setupWizard, false);
  assert.equal(parsed.localPeerId, "planner-a");
  assert.equal(parsed.role, "planner");
  assert.equal(parsed.domain, "protocol");
  assert.equal(parsed.capabilities.orchestration.provider, "pi-subagents");
});

test("parses peer do intents", () => {
  const status = parsePeerCommand("do status");
  assert.equal(status.subcommand, "do");
  assert.equal(status.intent, "status");
  assert.deepEqual(status.intentArgs, []);

  const goal = parsePeerCommand("do start goal Ship simpler peer setup --constraint safe");
  assert.equal(goal.intent, "start");
  assert.deepEqual(goal.intentArgs, ["goal", "Ship", "simpler", "peer", "setup"]);
  assert.deepEqual(goal.constraints, ["safe"]);

  const review = parsePeerCommand("do review goal_123");
  assert.equal(review.intent, "review");
  assert.deepEqual(review.intentArgs, ["goal_123"]);
});

test("parses peer subrun commands", () => {
  const status = parsePeerCommand("subrun status --goal goal_123");
  assert.equal(status.subcommand, "subrun");
  assert.equal(status.subrunAction, "status");
  assert.equal(status.goalId, "goal_123");

  const start = parsePeerCommand("subrun start Review implementation plan --goal goal_123 --mode parallel --provider pi-subagents");
  assert.equal(start.subrunAction, "start");
  assert.equal(start.summary, "Review implementation plan");
  assert.equal(start.goalId, "goal_123");
  assert.equal(start.mode, "parallel");
  assert.equal(start.provider, "pi-subagents");

  const progress = parsePeerCommand("subrun progress sub_123 Found one issue --artifact artifact:review");
  assert.equal(progress.subrunAction, "progress");
  assert.equal(progress.subrunId, "sub_123");
  assert.equal(progress.summary, "Found one issue");
  assert.deepEqual(progress.artifactRefs, ["artifact:review"]);

  const complete = parsePeerCommand("subrun complete sub_123 Done --done 2 --blocked 1");
  assert.equal(complete.subrunAction, "complete");
  assert.equal(complete.doneCount, 2);
  assert.equal(complete.blockedCount, 1);
});

test("peer help documents simplified primary workflow", () => {
  const help = formatPeerHelp();
  assert.match(help, /\/peer setup/);
  assert.match(help, /\/peer center/);
  assert.match(help, /\/peer do <intent>/);
  assert.match(help, /\/peer subrun/);
});
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```bash
node --test test/peer-command.test.mjs
```

Expected: FAIL because `center`, wizard setup actions, `do`, and `subrun` are not parsed yet.

- [ ] **Step 3: Implement parser changes**

In `src/peers/command.mjs`, add the new command names:

```js
export const PEER_COMMANDS = Object.freeze(["help", "status", "center", "context", "list", "init", "setup", "org", "doctor", "reconnect", "resume", "cancel", "send", "get", "await", "progress", "goal", "hive", "swarm", "self-improve", "improve", "do", "subrun"]);
```

Add parser branches after the `hive/self-improve/org` branches and before `progress`:

```js
if (subcommand === "do") {
  return parsePeerDoCommand(parsed, flags, positionals);
}
if (subcommand === "subrun") {
  return parsePeerSubrunCommand(parsed, flags, positionals);
}
```

Replace the existing `if (subcommand === "init" || subcommand === "setup")` block with this structure:

```js
if (subcommand === "init") {
  return parsePeerInitLikeCommand(parsed, flags, positionals);
}
if (subcommand === "setup") {
  if (hasLegacySetupFlags(flags)) return { ...parsePeerInitLikeCommand(parsed, flags, positionals), setupWizard: false };
  return parsePeerSetupWizardCommand(parsed, flags, positionals);
}
```

Add these helper functions near the existing parse helpers:

```js
function parsePeerInitLikeCommand(parsed, flags, _positionals) {
  const localPeerId = stringFlag(flags.id || flags.localPeerId, undefined);
  const role = stringFlag(flags.role, undefined);
  const domain = stringFlag(flags.domain, undefined);
  const persona = stringFlag(flags.persona, undefined);
  const trust = stringFlag(flags.trust, undefined);
  const capabilities = capabilitiesFromFlags(flags);
  const peer = stringFlag(flags.peer, undefined);
  const peerRole = stringFlag(flags.peerRole, undefined);
  const peerDomain = stringFlag(flags.peerDomain, undefined);
  const peerTrust = stringFlag(flags.peerTrust, undefined);
  const peerCapabilities = capabilitiesFromFlags({ intents: flags.peerIntents });
  const seedPeers = peer ? { [peer]: { ...(peerRole ? { role: peerRole } : {}), ...(peerDomain ? { domain: peerDomain } : {}), ...(peerTrust ? { trust: peerTrust } : {}), ...(Object.keys(peerCapabilities).length ? { capabilities: peerCapabilities } : {}) } } : undefined;
  return stripUndefined({
    ...parsed,
    localPeerId,
    role,
    domain,
    persona,
    trust,
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    seedPeers,
    enabled: !flagEnabled(flags.disabled),
  });
}

function hasLegacySetupFlags(flags = {}) {
  return ["id", "localPeerId", "role", "domain", "persona", "trust", "peer", "peerRole", "peerDomain", "peerTrust", "peerIntents", "intents", "write", "writeAccess", "readOnly", "subagents", "subagentProvider", "subagentsProvider", "disabled"].some((key) => flags[key] !== undefined);
}

function parsePeerSetupWizardCommand(parsed, flags, positionals) {
  const action = positionals[0] || "show";
  if (action === "reset") return { ...parsed, setupWizard: true, setupAction: "reset" };
  if (action === "done") return { ...parsed, setupWizard: true, setupAction: "done" };
  if (action === "id") {
    const localPeerId = positionals[1];
    if (!localPeerId) return { ...parsed, setupWizard: true, setupAction: "id", error: "/peer setup id requires <peer-id>" };
    return { ...parsed, setupWizard: true, setupAction: "id", localPeerId };
  }
  const setupChoice = setupChoiceFromArg(action);
  if (setupChoice) return { ...parsed, setupWizard: true, setupAction: "choice", setupChoice };
  if (action === "show") return { ...parsed, setupWizard: true, setupAction: "show" };
  return { ...parsed, setupWizard: true, setupAction: action, error: `Unknown /peer setup choice '${action}'` };
}

function setupChoiceFromArg(value) {
  const key = String(value || "").trim().toLowerCase();
  return ({
    "1": "coordinate",
    coordinate: "coordinate",
    coordinator: "coordinate",
    planner: "coordinate",
    "2": "implement",
    implement: "implement",
    implementation: "implement",
    code: "implement",
    worker: "implement",
    "3": "review",
    reviewer: "review",
    "4": "research",
    researcher: "research",
    "5": "subagents",
    subagent: "subagents",
    subagents: "subagents",
    "6": "status",
    status: "status",
    inspect: "status",
  })[key];
}
```

Add these parsers:

```js
function parsePeerDoCommand(parsed, flags, positionals) {
  const intent = (positionals[0] || "status").toLowerCase();
  const intentArgs = positionals.slice(1);
  const valid = ["setup", "status", "start", "coordinate", "review", "research", "work", "resolve-handoffs", "subagents"];
  if (!valid.includes(intent)) return { ...parsed, intent, intentArgs, error: `Unknown /peer do intent '${intent}'` };
  return {
    ...parsed,
    intent,
    intentArgs,
    constraints: listFlag(flags.constraint || flags.constraints),
    paths: listFlag(flags.path || flags.paths),
    lanes: listFlag(flags.lane || flags.lanes),
  };
}

function parsePeerSubrunCommand(parsed, flags, positionals) {
  const action = positionals[0] || "status";
  const rest = positionals.slice(1);
  const withAction = { ...parsed, subrunAction: action };
  if (!["status", "start", "progress", "complete", "cancel"].includes(action)) return { ...withAction, error: `Unknown /peer subrun action '${action}'` };
  const goalId = stringFlag(flags.goal || flags.goalId, undefined);
  if (action === "status") return { ...withAction, goalId };
  if (action === "start") {
    const summary = rest.join(" ").trim();
    if (!summary) return { ...withAction, goalId, error: "/peer subrun start requires <summary>" };
    return { ...withAction, summary, goalId, mode: stringFlag(flags.mode, "single"), provider: stringFlag(flags.provider, undefined), workKey: stringFlag(flags.workKey || flags.key, undefined), artifactRefs: listFlag(flags.artifact || flags.artifacts) };
  }
  const subrunId = rest[0];
  const summary = rest.slice(1).join(" ").trim();
  if (!subrunId) return { ...withAction, goalId, error: `/peer subrun ${action} requires <subrun-id>` };
  if (["progress", "complete"].includes(action) && !summary) return { ...withAction, goalId, subrunId, error: `/peer subrun ${action} requires <subrun-id> <summary>` };
  return { ...withAction, subrunId, summary, goalId, artifactRefs: listFlag(flags.artifact || flags.artifacts), doneCount: positiveIntegerFlag(flags.done || flags.completed), blockedCount: positiveIntegerFlag(flags.blocked), childCount: positiveIntegerFlag(flags.child || flags.children) };
}
```

- [ ] **Step 4: Update help**

In `formatPeerHelp()`, add these lines near the top:

```js
"- `/peer setup` then `/peer setup <choice>` - guided role/session setup wizard",
"- `/peer center` - show the daily peer command center with recommended next actions",
"- `/peer do <intent>` - route common workflows such as status, review, research, work, resolve-handoffs, and subagents",
"- `/peer subrun status|start|progress|complete|cancel` - manage optional private subagent run summaries",
```

Keep the existing detailed command lines below these primary workflow lines.

- [ ] **Step 5: Run parser tests and commit**

Run:

```bash
node --test test/peer-command.test.mjs
```

Expected: PASS.

Commit only parser/help files:

```bash
git add src/peers/command.mjs test/peer-command.test.mjs
git commit -m "feat: parse peer command center facade"
```

### Task 2: Setup Wizard Module

**Files:**

- Create: `src/peers/setup-wizard.mjs`
- Create: `test/peer-setup-wizard.test.mjs`

- [ ] **Step 1: Write failing setup wizard tests**

Create `test/peer-setup-wizard.test.mjs`:

```js
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadPeerRuntimeConfig } from "../src/peers/config.mjs";
import { loadPeerOrg } from "../src/peers/org.mjs";
import {
  applyPeerSetupChoice,
  formatPeerSetupPrompt,
  loadPeerSetupSession,
  resetPeerSetupSession,
} from "../src/peers/setup-wizard.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-setup-wizard-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("formatPeerSetupPrompt asks for the six session uses", () => {
  const text = formatPeerSetupPrompt();
  assert.match(text, /What do you want this session to do/);
  assert.match(text, /1\. Coordinate other peers/);
  assert.match(text, /2\. Implement code/);
  assert.match(text, /5\. Manage private subagents/);
  assert.match(text, /Reply with \/peer setup <number>/);
});

test("applyPeerSetupChoice creates peer config and org role for coordinator", async (t) => {
  await withRoot(t, async (root) => {
    const result = await applyPeerSetupChoice(root, {
      choice: "coordinate",
      peerId: "planner-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    assert.equal(result.ok, true);
    assert.equal(result.choice.role, "coordinator");
    assert.equal(result.choice.domain, "coordination");

    const config = await loadPeerRuntimeConfig(root, { env: {} });
    assert.equal(config.enabled, true);
    assert.equal(config.localPeerId, "planner-a");
    assert.equal(config.peers.find((peer) => peer.peerId === "planner-a").role, "coordinator");

    const org = await loadPeerOrg(root);
    assert.equal(org.org.peers["planner-a"].role, "coordinator");
    assert.equal(org.org.peers["planner-a"].domain, "coordination");
    assert.equal(org.org.peers["planner-a"].manager, true);
  });
});

test("applyPeerSetupChoice safely fills missing local peer profile without overwriting existing role", async (t) => {
  await withRoot(t, async (root) => {
    await writeFile(join(root, ".pi/peers.json"), JSON.stringify({
      enabled: true,
      localPeerId: "worker-a",
      manifest: { capabilities: { intents: ["ask"] } },
      peers: { "worker-a": { role: "reviewer", domain: "quality", trust: "conversation" } },
    }, null, 2));

    await applyPeerSetupChoice(root, {
      choice: "implement",
      peerId: "worker-a",
      runtime: { summary: { localPeerIdSource: ".pi/peers.json:localPeerId" } },
    });

    const raw = JSON.parse(await readFile(join(root, ".pi/peers.json"), "utf8"));
    assert.equal(raw.peers["worker-a"].role, "reviewer");
    assert.equal(raw.peers["worker-a"].domain, "quality");

    const org = await loadPeerOrg(root);
    assert.equal(org.org.peers["worker-a"].role, "implementer");
    assert.equal(org.org.peers["worker-a"].domain, "implementation");
  });
});

test("subagents choice enables optional orchestration metadata", async (t) => {
  await withRoot(t, async (root) => {
    await applyPeerSetupChoice(root, {
      choice: "subagents",
      peerId: "planner-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    const config = await loadPeerRuntimeConfig(root, { env: {} });
    assert.equal(config.manifest.capabilities.orchestration.subagents, true);
    assert.equal(config.manifest.capabilities.orchestration.provider, "pi-subagents");

    const org = await loadPeerOrg(root);
    assert.equal(org.org.peers["planner-a"].canSpawnSubagents, true);
  });
});

test("generated runtime identity requires explicit setup id", async (t) => {
  await withRoot(t, async (root) => {
    await assert.rejects(
      applyPeerSetupChoice(root, {
        choice: "review",
        runtime: { localPeerId: "generated-peer", summary: { localPeerIdSource: "generated" } },
      }),
      /\/peer setup id <peer-id>/,
    );
  });
});

test("setup session reset only removes wizard state", async (t) => {
  await withRoot(t, async (root) => {
    await applyPeerSetupChoice(root, {
      choice: "research",
      peerId: "researcher-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });
    assert.equal((await loadPeerSetupSession(root)).choice, "research");

    await resetPeerSetupSession(root);
    assert.equal((await loadPeerSetupSession(root)).exists, false);

    const config = await loadPeerRuntimeConfig(root, { env: {} });
    assert.equal(config.localPeerId, "researcher-a");
    const org = await loadPeerOrg(root);
    assert.equal(org.org.peers["researcher-a"].role, "researcher");
  });
});
```

- [ ] **Step 2: Run setup wizard tests and verify failure**

Run:

```bash
node --test test/peer-setup-wizard.test.mjs
```

Expected: FAIL because `src/peers/setup-wizard.mjs` does not exist.

- [ ] **Step 3: Implement setup wizard module**

Create `src/peers/setup-wizard.mjs` with these exports:

```js
export const PEER_SETUP_SESSION_RELATIVE_PATH = ".pi/peer-setup-session.json";
export const PEER_SETUP_CHOICES = Object.freeze({
  coordinate: { label: "Coordinate other peers", role: "coordinator", domain: "coordination", canSpawnSubagents: true, countsForIndependentVote: true },
  implement: { label: "Implement code", role: "implementer", domain: "implementation", canSpawnSubagents: true, countsForIndependentVote: false },
  review: { label: "Review work", role: "reviewer", domain: "review", canSpawnSubagents: true, countsForIndependentVote: true },
  research: { label: "Research", role: "researcher", domain: "research", canSpawnSubagents: true, countsForIndependentVote: true },
  subagents: { label: "Manage private subagents", role: "coordinator", domain: "coordination", canSpawnSubagents: true, countsForIndependentVote: true, forceSubagents: true },
  status: { label: "Inspect status only", role: undefined, domain: undefined, canSpawnSubagents: false, countsForIndependentVote: undefined, inspectOnly: true },
});
```

Export these functions:

- `setupWizardPath(root)`
- `loadPeerSetupSession(root)`
- `savePeerSetupSession(root, input = {})`
- `resetPeerSetupSession(root)`
- `normalizePeerSetupChoice(value)`
- `formatPeerSetupPrompt(input = {})`
- `applyPeerSetupChoice(root, input = {})`
- `formatPeerSetupResult(result = {})`

Use these behavior rules in `applyPeerSetupChoice`:

- `choice: "status"` writes only setup session state and returns a result with `inspectOnly: true`.
- Resolve the peer id from `input.peerId`, then `runtime.localPeerId`, then `runtime.summary.localPeerId`.
- Reject generated or missing identity sources with this exact guidance text: `Run /peer setup id <peer-id> first, then repeat /peer setup <choice>.`
- Call `initPeerConfig(root, { localPeerId, role, domain, capabilities })`; this creates `.pi/peers.json` only when missing.
- When `.pi/peers.json` exists, read the raw JSON and fill only missing local profile fields for the local peer. Do not replace an existing `role`, `domain`, `persona`, or `manifest.capabilities.orchestration`.
- Call `setPeerOrgRole(root, peerId, { role, domain, canSpawnSubagents })` for every non-status choice.
- Save `.pi/peer-setup-session.json` with `{ version: 1, peerId, choice, role, domain, canSpawnSubagents, updatedAt }`.

Use this capabilities shape for choices that enable subagents:

```js
{
  orchestration: {
    subagents: true,
    provider: "pi-subagents",
    modes: ["single", "parallel", "chain", "async"],
    maxDepth: 1,
    maxConcurrency: 4,
    worktree: true,
    intercom: false,
  },
}
```

Use these output lines in `formatPeerSetupResult`:

```txt
Peer setup updated

Local: planner-a
Role: coordinator
Domain: coordination
Subagents: yes

Next:
1. /peer center
2. /peer setup done
```

- [ ] **Step 4: Run setup wizard tests and commit**

Run:

```bash
node --test test/peer-setup-wizard.test.mjs
```

Expected: PASS.

Commit:

```bash
git add src/peers/setup-wizard.mjs test/peer-setup-wizard.test.mjs
git commit -m "feat: add peer setup wizard"
```

### Task 3: Command Center Projection

**Files:**

- Create: `src/peers/command-center.mjs`
- Create: `test/peer-command-center.test.mjs`

- [ ] **Step 1: Write failing command center tests**

Create `test/peer-command-center.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPeerCommandCenterState,
  derivePeerCommandCenterRecommendations,
  formatPeerCommandCenter,
} from "../src/peers/command-center.mjs";

test("command center renders local profile, org, peers, goal blockers, and subruns", () => {
  const state = buildPeerCommandCenterState({
    runtimeStatus: {
      enabled: true,
      localPeerId: "planner-a",
      localRole: "coordinator",
      localDomain: "coordination",
      peers: [
        { peerId: "reviewer-a", status: "active", role: "reviewer", domain: "review" },
        { peerId: "worker-a", status: "active", role: "implementer", domain: "implementation" },
      ],
    },
    orgState: {
      exists: true,
      org: {
        spawnPolicy: { enabled: true, provider: "optional", privateTeams: true },
        peers: { "planner-a": { role: "coordinator", domain: "coordination", canSpawnSubagents: true } },
      },
    },
    goals: [
      { id: "goal_123", objective: "Ship setup wizard", readyToClose: false, activeTasks: [], activeClaims: [], staleClaims: [], blockingObjections: [{ id: "obj_1" }], unresolvedTaskHandoffs: [{ handoffEventId: "evt_1" }], openProposals: [] },
    ],
    controlState: {
      activeTasks: [],
      disconnectedTasks: [],
      activeSubruns: [{ subrunId: "sub_1", status: "running", provider: "manual", summary: "private review" }],
      completedSubruns: [],
    },
  });

  const text = formatPeerCommandCenter(state);
  assert.match(text, /Peer command center/);
  assert.match(text, /Local: planner-a .* role coordinator .* domain coordination .* subagents yes/);
  assert.match(text, /Peers: 2 active/);
  assert.match(text, /review: reviewer-a/);
  assert.match(text, /implementation: worker-a/);
  assert.match(text, /Org: configured .* private teams enabled .* provider optional/);
  assert.match(text, /Goals: goal_123 ready no .* blockers 1 .* active tasks 0 .* subruns 1/);
  assert.match(text, /\/peer do resolve-handoffs/);
});

test("recommendations prioritize disconnected tasks, unresolved handoffs, review, and setup", () => {
  const recommendations = derivePeerCommandCenterRecommendations({
    setup: { exists: false },
    goals: [{ id: "goal_123", currentVotes: [], unresolvedTaskHandoffs: [{ handoffEventId: "evt_1" }], activeTasks: [], activeClaims: [], staleClaims: [], blockingObjections: [], openProposals: [] }],
    control: { disconnectedTasks: [{ messageId: "msg_1" }], activeSubruns: [] },
  });

  assert.equal(recommendations[0].command, "/peer reconnect");
  assert.equal(recommendations[1].command, "/peer do resolve-handoffs");
  assert.equal(recommendations.some((item) => item.command === "/peer do review goal_123"), true);
  assert.equal(recommendations.some((item) => item.command === "/peer setup"), true);
});
```

- [ ] **Step 2: Run command center tests and verify failure**

Run:

```bash
node --test test/peer-command-center.test.mjs
```

Expected: FAIL because `command-center.mjs` does not exist.

- [ ] **Step 3: Implement command center module**

Create `src/peers/command-center.mjs` with these exports:

- `buildPeerCommandCenterState(input = {})`
- `derivePeerCommandCenterRecommendations(state = {})`
- `formatPeerCommandCenter(state = {})`
- `formatPeerIntentResult(result = {})`

Implementation rules:

- Group active peers by `role` first, then by `domain`, with missing role/domain rendered as `unknown`.
- Determine local subagent capability from org peer `canSpawnSubagents` first, then runtime `localCapabilities.orchestration.subagents`.
- Use at most three active peer ids per role group in the top summary.
- Pick the current goal from `input.currentGoal`, then the first open goal with blockers/handoffs, then the first open goal.
- Recommendation priority:
  1. disconnected tasks -> `/peer reconnect`
  2. stale claims -> `/peer do coordinate <goal-id>`
  3. unresolved handoffs -> `/peer do resolve-handoffs`
  4. blockers -> `/peer do coordinate <goal-id>`
  5. missing vote/current review -> `/peer do review <goal-id>`
  6. active subruns -> `/peer subrun status`
  7. setup missing -> `/peer setup`
  8. no goals -> `/peer do start goal "<objective>"`
- Render command-center text with stable headings: `Peer command center`, `Recommended:`.

- [ ] **Step 4: Run command center tests and commit**

Run:

```bash
node --test test/peer-command-center.test.mjs
```

Expected: PASS.

Commit:

```bash
git add src/peers/command-center.mjs test/peer-command-center.test.mjs
git commit -m "feat: add peer command center"
```

### Task 4: Intent Router

**Files:**

- Modify: `src/peers/command-center.mjs`
- Modify: `test/peer-command-center.test.mjs`

- [ ] **Step 1: Write failing intent router tests**

Append to `test/peer-command-center.test.mjs`:

```js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPeerGoalBoard } from "../src/peers/goal-board.mjs";
import { routePeerIntent } from "../src/peers/command-center.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-command-center-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("routePeerIntent status returns command center text", async (t) => {
  await withRoot(t, async (root) => {
    const result = await routePeerIntent(root, {
      intent: "status",
      intentArgs: [],
    }, {
      runtimeStatus: { localPeerId: "planner-a", localRole: "coordinator", localDomain: "coordination", peers: [] },
      orgState: { exists: false, org: { peers: {}, spawnPolicy: {} } },
      controlState: { activeTasks: [], disconnectedTasks: [], activeSubruns: [] },
      goals: [],
      setupSession: { exists: false },
    });

    assert.equal(result.mutated, false);
    assert.match(result.text, /Peer command center/);
  });
});

test("routePeerIntent start goal creates a goal and seed proposals", async (t) => {
  await withRoot(t, async (root) => {
    const result = await routePeerIntent(root, {
      intent: "start",
      intentArgs: ["goal", "Ship", "simpler", "setup"],
      constraints: ["safe"],
    }, {
      peerId: "planner-a",
      runtimeStatus: { localPeerId: "planner-a" },
    });

    assert.equal(result.mutated, true);
    assert.match(result.text, /Created peer goal/);
    const board = await loadPeerGoalBoard(root);
    const goal = board.goals[board.currentGoalId];
    assert.equal(goal.objective, "Ship simpler setup");
    assert.equal(goal.events.filter((event) => event.type === "proposal").length >= 3, true);
  });
});

test("routePeerIntent work without explicit paths is conservative", async (t) => {
  await withRoot(t, async (root) => {
    const result = await routePeerIntent(root, {
      intent: "work",
      intentArgs: ["goal_123"],
      paths: [],
    }, {
      peerId: "worker-a",
      runtimeStatus: { localPeerId: "worker-a" },
      goals: [{ id: "goal_123", objective: "Ship", activeClaims: [], activeTasks: [], staleClaims: [], unresolvedTaskHandoffs: [], blockingObjections: [], openProposals: [], currentVotes: [] }],
    });

    assert.equal(result.mutated, false);
    assert.match(result.text, /No write claim created/);
    assert.match(result.text, /\/peer goal claim goal_123/);
  });
});
```

- [ ] **Step 2: Run intent tests and verify failure**

Run:

```bash
node --test test/peer-command-center.test.mjs
```

Expected: FAIL because `routePeerIntent` is not exported.

- [ ] **Step 3: Implement intent routing**

In `src/peers/command-center.mjs`, export `routePeerIntent(root, parsed, context = {})`.

Behavior by intent:

- `setup`: return `formatPeerSetupPrompt()` text and `mutated: false`.
- `status`: return `formatPeerCommandCenter(buildPeerCommandCenterState(context))` and `mutated: false`.
- `start goal <objective>`: call `createPeerGoal(root, { objective, constraints, peerId })`, then append read-only `proposal` events for `research`, `review`, and `implementation` lanes. Return exact commands for `/peer scout <goal-id>` and `/peer center`.
- `coordinate`: return stale claim, blocker, proposal, and handoff cleanup commands. Create no claim unless a later task adds explicit mode flags.
- `review <goal-id>` and `research <goal-id>`: return exact read-only claim commands with stable work keys.
- `work <goal-id>`: if no `paths` were parsed, return `No write claim created` plus a read-only implementation-planning claim command. If paths exist, return the exact `/peer goal claim <goal-id> <summary> --mode write --path <path>` command and leave mutation to the user.
- `resolve-handoffs`: return `/peer goal resolve <goal-id> <handoff-id> "accepted or superseded unsuccessful peer handoff"` for each unresolved handoff.
- `subagents`: return `/peer subrun status` and, when no active subruns exist, an example `/peer subrun start "<summary>" --goal <goal-id>` command.

Use `shellQuote` locally in `command-center.mjs` for copyable commands.

- [ ] **Step 4: Run intent tests and commit**

Run:

```bash
node --test test/peer-command-center.test.mjs
```

Expected: PASS.

Commit:

```bash
git add src/peers/command-center.mjs test/peer-command-center.test.mjs
git commit -m "feat: route peer do intents"
```

### Task 5: Subagent Adapter And Subrun Lifecycle

**Files:**

- Create: `src/peers/subagents.mjs`
- Create: `test/peer-subagents.test.mjs`

- [ ] **Step 1: Write failing subagent tests**

Create `test/peer-subagents.test.mjs`:

```js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createPeerGoal, deriveGoalState, loadPeerGoalBoard } from "../src/peers/goal-board.mjs";
import { derivePeerControlState, loadPeerControlLedger } from "../src/peers/control-ledger.mjs";
import {
  cancelPeerSubagentRun,
  completePeerSubagentRun,
  formatPeerSubagentRunResult,
  formatPeerSubagentStatus,
  recordPeerSubagentRunProgress,
  resolveSubagentProvider,
  startPeerSubagentRun,
} from "../src/peers/subagents.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-subagents-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("missing provider returns manual blocked subrun without throwing", async (t) => {
  await withRoot(t, async (root) => {
    const result = await startPeerSubagentRun(root, {
      summary: "Review implementation",
      goalId: "goal_123",
      parentPeerId: "planner-a",
      provider: "pi-subagents",
      importModule: async () => undefined,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.provider, "pi-subagents");
    assert.match(result.message, /provider unavailable/);

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns.length, 0);
    assert.equal(state.completedSubruns.length, 1);
    assert.equal(state.completedSubruns[0].status, "blocked");
  });
});

test("subrun progress, complete, and status format compact state", async (t) => {
  await withRoot(t, async (root) => {
    const started = await startPeerSubagentRun(root, {
      summary: "Private research team",
      goalId: "goal_123",
      parentPeerId: "researcher-a",
      provider: "manual",
    });

    await recordPeerSubagentRunProgress(root, {
      subrunId: started.subrunId,
      summary: "Found two sources",
      artifactRefs: ["artifact:sources"],
    });
    await completePeerSubagentRun(root, {
      subrunId: started.subrunId,
      summary: "Research complete",
      doneCount: 2,
      blockedCount: 0,
      artifactRefs: ["artifact:summary"],
    });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns.length, 0);
    assert.equal(state.completedSubruns.length, 1);
    assert.deepEqual(state.completedSubruns[0].artifactRefs, ["artifact:sources", "artifact:summary"]);

    assert.match(formatPeerSubagentStatus({ controlState: state }), /Subruns/);
    assert.match(formatPeerSubagentRunResult({ ...started, status: "running" }), /Subrun/);
  });
});

test("completePeerSubagentRun can attach bounded subagent evidence to parent goal handoff", async (t) => {
  await withRoot(t, async (root) => {
    const created = await createPeerGoal(root, { objective: "Ship private teams", peerId: "planner-a" });
    const started = await startPeerSubagentRun(root, {
      summary: "Implementation private team",
      goalId: created.id,
      parentPeerId: "worker-a",
      provider: "manual",
      mode: "parallel",
    });

    await completePeerSubagentRun(root, {
      subrunId: started.subrunId,
      goalId: created.id,
      parentPeerId: "worker-a",
      summary: "Implementation private team complete",
      childCount: 3,
      doneCount: 2,
      blockedCount: 1,
      artifactRefs: ["artifact:subrun"],
      attachHandoff: true,
    });

    const goal = (await loadPeerGoalBoard(root)).goals[created.id];
    const state = deriveGoalState(goal);
    const handoff = state.events.find((event) => event.type === "handoff" && event.taskId === started.subrunId);
    assert.equal(handoff.subagentEvidence.childCount, 3);
    assert.equal(handoff.subagentEvidence.doneCount, 2);
    assert.equal(handoff.subagentEvidence.blockedCount, 1);
  });
});

test("cancelPeerSubagentRun records a terminal cancelled subrun", async (t) => {
  await withRoot(t, async (root) => {
    const started = await startPeerSubagentRun(root, { summary: "Private review", provider: "manual" });
    await cancelPeerSubagentRun(root, { subrunId: started.subrunId, summary: "No longer needed" });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.completedSubruns[0].status, "cancelled");
  });
});

test("resolveSubagentProvider supports injected provider modules for deterministic tests", async (t) => {
  await withRoot(t, async (root) => {
    const provider = await resolveSubagentProvider(root, {
      provider: "pi-subagents",
      importModule: async () => ({ startPeerSubagents: async () => ({ ok: true, runId: "provider-run" }) }),
    });

    assert.equal(provider.name, "pi-subagents");
    assert.equal(provider.available, true);
  });
});
```

- [ ] **Step 2: Run subagent tests and verify failure**

Run:

```bash
node --test test/peer-subagents.test.mjs
```

Expected: FAIL because `src/peers/subagents.mjs` does not exist.

- [ ] **Step 3: Implement subagent adapter**

Create `src/peers/subagents.mjs` with these exports:

```js
export const PEER_SUBAGENT_LEDGER_KIND = "subrun";
```

Also export these functions:

- `normalizeSubagentRunRequest(input = {})`
- `normalizeSubagentRunSummary(input = {})`
- `resolveSubagentProvider(root, input = {})`
- `startPeerSubagentRun(root, input = {})`
- `recordPeerSubagentRunProgress(root, input = {})`
- `completePeerSubagentRun(root, input = {})`
- `cancelPeerSubagentRun(root, input = {})`
- `formatPeerSubagentRunResult(result = {})`
- `formatPeerSubagentStatus(input = {})`

Implementation rules:

- Generate subrun ids as `sub_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`.
- Treat supported modes as `single`, `parallel`, `chain`, and `async`; default to `single`.
- Resolve provider order from explicit `input.provider`, then `org.spawnPolicy.provider`, then `capabilities.orchestration.provider`, then `manual`.
- Dynamic import only through `input.importModule || ((name) => import(name).catch(() => undefined))`.
- Recognize a provider module as available when it exports `startPeerSubagents`, `startSubagentRun`, or `runSubagents`.
- If the requested provider is not available, append a `subrun` record with `action: "blocked"` and `status: "blocked"`; return `{ ok: false, status: "blocked" }`.
- For manual provider, append `action: "started"` and `status: "running"`.
- Progress appends `action: "progress"` and `status: "progress"`.
- Complete appends `action: "done"` and `status: "done"` unless `blockedCount > 0 && doneCount > 0`, in which case use `status: "partial"`.
- Cancel appends `action: "cancelled"` and `status: "cancelled"`.
- All records must write `metadata.provider`, `metadata.mode`, `metadata.artifactRefs`, `metadata.childCount`, `metadata.completedCount`, and `metadata.blockedCount` only when present.
- When `completePeerSubagentRun` receives `attachHandoff: true` and `goalId`, it calls `completePeerGoalTask(root, goalId, { messageId: subrunId, peerId: parentPeerId, status, summary, subagentEvidence })`.

Use the existing `appendPeerControlRecord`, `loadPeerControlLedger`, `derivePeerControlState`, and `completePeerGoalTask` helpers.

- [ ] **Step 4: Run subagent tests and commit**

Run:

```bash
node --test test/peer-subagents.test.mjs
```

Expected: PASS.

Commit:

```bash
git add src/peers/subagents.mjs test/peer-subagents.test.mjs
git commit -m "feat: add optional peer subrun adapter"
```

### Task 6: Extension Wiring

**Files:**

- Modify: `extensions/pi-peer/index.ts`

- [ ] **Step 1: Add extension integration checks to existing parser/module tests**

No dedicated extension test harness exists. Use module tests from Tasks 1-5 as the primary safety net, then verify the extension imports compile through `npm test` and `npm pack --dry-run` in Task 8.

- [ ] **Step 2: Wire imports**

In `extensions/pi-peer/index.ts`, extend imports:

```ts
import { applyPeerSetupChoice, formatPeerSetupPrompt, formatPeerSetupResult, resetPeerSetupSession } from "../../src/peers/setup-wizard.mjs";
import { buildPeerCommandCenterState, formatPeerCommandCenter, routePeerIntent } from "../../src/peers/command-center.mjs";
import { cancelPeerSubagentRun, completePeerSubagentRun, formatPeerSubagentRunResult, formatPeerSubagentStatus, recordPeerSubagentRunProgress, startPeerSubagentRun } from "../../src/peers/subagents.mjs";
```

If TypeScript complains about ESM type inference, keep the same runtime imports and use `any` in local variables, matching the rest of this extension file.

- [ ] **Step 3: Add command completions**

Add these values to `getArgumentCompletions`:

```ts
"center", "do", "subrun"
```

- [ ] **Step 4: Route wizard setup before legacy init**

In `handlePeerCommand`, replace the top setup/init block with:

```ts
if (parsed.subcommand === "setup" && parsed.setupWizard) {
  const runtime = await runtimeFor(pi, ctx.cwd);
  if (parsed.setupAction === "show") return sendPeerMessage(pi, formatPeerSetupPrompt());
  if (parsed.setupAction === "reset") {
    await resetPeerSetupSession(ctx.cwd || process.cwd());
    await refresh();
    return sendPeerMessage(pi, "Peer setup wizard state reset.\n\nNext: /peer setup");
  }
  const result = await applyPeerSetupChoice(ctx.cwd || process.cwd(), {
    choice: parsed.setupChoice,
    peerId: parsed.localPeerId,
    runtime,
  });
  await resetRuntimeFor(ctx.cwd);
  const nextRuntime = await runtimeFor(pi, ctx.cwd);
  if (nextRuntime.enabled) await nextRuntime.start(ctx);
  await refresh();
  return sendPeerMessage(pi, formatPeerSetupResult(result));
}

if (parsed.subcommand === "init" || (parsed.subcommand === "setup" && !parsed.setupWizard)) {
  const result = await initPeerConfig(ctx.cwd || process.cwd(), { localPeerId: parsed.localPeerId, role: parsed.role, domain: parsed.domain, persona: parsed.persona, trust: parsed.trust, capabilities: parsed.capabilities, seedPeers: parsed.seedPeers, enabled: parsed.enabled });
  await resetRuntimeFor(ctx.cwd);
  const runtime = await runtimeFor(pi, ctx.cwd);
  if (runtime.enabled) await runtime.start(ctx);
  await refresh();
  const suffix = parsed.subcommand === "setup" ? "\n\nNext: /peer center" : "";
  return sendPeerMessage(pi, `${formatPeerInitResult(result)}${suffix}`);
}
```

- [ ] **Step 5: Add center and intent handlers**

Add a local helper near `handlePeerOrgCommand`:

```ts
async function collectPeerCommandCenterInput(ctx: any, runtime: any) {
  const root = ctx?.cwd || process.cwd();
  const runtimeStatus = await collectPeerRuntimeStatus(runtime);
  const orgState = await loadPeerOrg(root, { allowMissing: true });
  const board = await loadPeerGoalBoard(root).catch(() => ({ goals: {}, currentGoalId: undefined }));
  const goals = Object.values(board.goals || {}).map((goal: any) => deriveGoalState(goal));
  const loadedControl = await loadPeerControlLedger(root);
  const controlState = derivePeerControlState(loadedControl.records);
  return { runtimeStatus, orgState, goals, currentGoalId: board.currentGoalId, controlState };
}
```

Make sure `deriveGoalState` is imported from `goal-board.mjs`; it is already used by status code, but not currently imported in the extension.

Add handlers before the `ensureEnabled(runtime)` section:

```ts
if (parsed.subcommand === "center") {
  if (runtime.enabled) await runtime.refreshLocalPeers();
  const input = await collectPeerCommandCenterInput(ctx, runtime);
  await refresh();
  return sendPeerMessage(pi, formatPeerCommandCenter(buildPeerCommandCenterState(input)));
}

if (parsed.subcommand === "do") {
  if (runtime.enabled) await runtime.refreshLocalPeers();
  const input = await collectPeerCommandCenterInput(ctx, runtime);
  const result = await routePeerIntent(ctx?.cwd || process.cwd(), parsed, {
    ...input,
    peerId: runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown",
  });
  await refresh();
  return sendPeerMessage(pi, result.text);
}
```

- [ ] **Step 6: Add subrun handler**

Add handler before `ensureEnabled(runtime)` so status can work even when peer messaging is disabled:

```ts
if (parsed.subcommand === "subrun") {
  const root = ctx?.cwd || process.cwd();
  let result: any;
  if (parsed.subrunAction === "status") {
    const loadedControl = await loadPeerControlLedger(root);
    const controlState = derivePeerControlState(loadedControl.records);
    await refresh();
    return sendPeerMessage(pi, formatPeerSubagentStatus({ controlState, goalId: parsed.goalId }));
  }
  const parentPeerId = runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown";
  if (parsed.subrunAction === "start") result = await startPeerSubagentRun(root, { ...parsed, parentPeerId });
  if (parsed.subrunAction === "progress") result = await recordPeerSubagentRunProgress(root, parsed);
  if (parsed.subrunAction === "complete") result = await completePeerSubagentRun(root, { ...parsed, parentPeerId, attachHandoff: Boolean(parsed.goalId) });
  if (parsed.subrunAction === "cancel") result = await cancelPeerSubagentRun(root, parsed);
  await refresh();
  return sendPeerMessage(pi, formatPeerSubagentRunResult(result));
}
```

- [ ] **Step 7: Run targeted tests and commit**

Run:

```bash
npm test
```

Expected: PASS.

Commit:

```bash
git add extensions/pi-peer/index.ts
git commit -m "feat: wire peer command center extension commands"
```

### Task 7: README Workflow Documentation

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Update README primary workflow**

Add a short section near the quick start that shows the simplified flow:

````md
## Simplified command center workflow

Most sessions can start with the guided setup wizard:

```bash
/peer setup
/peer setup 1
/peer center
```

Use `/peer setup <choice>` to choose what the current Pi session should do:

1. Coordinate other peers
2. Implement code
3. Review work
4. Research
5. Manage private subagents
6. Inspect status only

After setup, `/peer center` shows the local role/domain, active peers, goal-board state, subruns, and recommended next commands. `/peer do <intent>` handles common workflows such as `status`, `review`, `research`, `work`, `resolve-handoffs`, and `subagents` without requiring the full command tree.

Private subagent teams are optional. `/peer subrun start <summary>` records compact local subagent work in `.pi/peer-control-ledger.jsonl`; if `pi-subagents` is not installed, the command records a blocked/manual subrun instead of crashing.
````

- [ ] **Step 2: Run README command parser sanity tests**

Run:

```bash
node --test test/peer-command.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit docs**

Commit:

```bash
git add README.md
git commit -m "docs: document peer command center workflow"
```

### Task 8: Full Verification

**Files:**

- Modify only if verification finds a defect in a file owned by Tasks 1-7.

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run package dry run**

Run:

```bash
npm run check:pack
```

Expected: PASS and package contents include `src/peers/setup-wizard.mjs`, `src/peers/command-center.mjs`, and `src/peers/subagents.mjs`.

- [ ] **Step 3: Run full check**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 4: Inspect git state**

Run:

```bash
git status --short
git log --oneline -5
```

Expected:

- Only unrelated pre-existing dirty files remain outside the feature commits.
- Feature commits from Tasks 1-7 are visible in the recent log.

## Spec Coverage Checklist

- Setup wizard asks the user what this session should utilize: Task 2 and Task 6.
- User replies with `/peer setup <choice>`: Task 1 and Task 2.
- Peers are domain managers: Task 2 updates org role/domain through `setPeerOrgRole`.
- One TUI command center over many commands: Task 3 and Task 6.
- Existing commands remain available: Task 1 preserves legacy setup flags and keeps existing command parser branches.
- `/peer do <intent>` facade: Task 4 and Task 6.
- Optional private subagent teams: Task 5 and Task 6.
- No hard `pi-subagents` dependency: Task 5 uses dynamic import and manual fallback.
- Subagent votes do not satisfy independent top-level gates: existing goal-board tests remain in full verification.
- Compact ledger evidence: Task 5 uses existing `kind: "subrun"` control ledger derivation.
- README simplified workflow: Task 7.

## Execution Notes

- Stage commits by exact file path. The worktree currently has unrelated edits in `src/peers/self-improve.mjs` and `test/peer-self-improve.test.mjs`; do not stage or revert them unless the user explicitly changes scope.
- Keep the first provider integration deterministic. Tests inject a fake provider module; do not require network access or an installed `pi-subagents` package.
- If the real `pi-subagents` API is inspected before expanding provider support, use the repo-approved `/gstack-browse` workflow and keep any new provider-specific behavior behind the same dynamic import boundary.
