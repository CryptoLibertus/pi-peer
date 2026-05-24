# Agentic Factory Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn pi-peer into a verification-first agentic coding factory with structured runs, gates, rework, adversarial planning, context lifecycle, tool governance, metrics, PR shepherding, evals, and optional automations.

**Architecture:** Keep the existing Pi extension and peer protocol as the user-facing shell. Add focused peer modules under `src/peers/` and durable runtime artifacts under `.pi/factory/`, `.pi/context/`, `.pi/evals/`, `.pi/tools/`, and `.pi/automations/`. Expose the new system primarily through `/peer center` and `/peer do`, with `/peer factory ...` as the advanced control surface.

**Tech Stack:** Node 20 ESM, TypeScript Pi extension entrypoint, Node `node:test`, append-only JSONL ledgers, JSON runtime policies, existing goal-board/control-ledger/subagent modules.

---

## Scope And Sequencing

This is one umbrella plan with ten connected improvements from `agentic_coding_system_self_improvement_playbook.md`. Implement it in phases because each phase produces independently testable behavior:

1. Factory run ledger and command surface.
2. Verification gates and rework manager.
3. Plan adversary and DAG-style plan records.
4. Context-as-code lifecycle and tool registry.
5. Metrics dashboard and command-center integration.
6. PR shepherd, eval suites, and automation catalog.
7. Setup wizard simplification and documentation.

The critical design choice is that **factory behavior observes and records first**. Automatic shell execution, PR operations, and scheduled automations stay opt-in and policy-gated.

## User Experience Target

Primary path:

```text
/peer setup
/peer setup <choice>
/peer center
/peer do start goal "Improve protocol layer"
/peer do plan <goal-id>
/peer do verify <goal-id>
/peer do rework <run-id>
/peer do metrics
```

Advanced path:

```text
/peer factory init
/peer factory run "Improve protocol layer" --goal <goal-id> --path src/peers --gate test --gate pack
/peer factory gate <run-id> test pass --evidence "npm test passed"
/peer factory rework <run-id> --reason "test failed" --failure test --owner reviewer
/peer factory metrics
```

The command center should recommend the advanced commands so normal users do not need to memorize them.

## New Runtime Artifacts

Generated under the user's repo:

```text
.pi/factory/
  runs.jsonl
  gates.json
  rework-policy.json
  plans.jsonl
  pr-shepherd.jsonl
  metrics-snapshots.jsonl

.pi/context/
  patches.jsonl
  retros.jsonl
  eval-results.jsonl

.pi/evals/
  task-evals.json
  context-evals.json
  scenario-evals.json

.pi/tools/
  registry.json

.pi/automations/
  catalog.json
  runs.jsonl
```

Rationale: the existing package already treats `.pi/` as local runtime state. These artifacts should be safe to create in any consuming repo without adding version-controlled files unexpectedly.

## File Structure

Create:

- `src/peers/factory.mjs`  
  Factory init, run ledger append/load, run state derivation, formatting for status and run detail.

- `src/peers/gates.mjs`  
  Verification gate policy defaults, gate policy load/init, gate result normalization, gate readiness summaries.

- `src/peers/rework.mjs`  
  Failure taxonomy, attempt/rework policy, next-action derivation, escalation rules.

- `src/peers/plan-adversary.mjs`  
  Plan contract normalization, DAG/dependency checks, file ownership checks, human escalation checks, adversarial review formatting.

- `src/peers/context-lifecycle.mjs`  
  Context patch ledger, repeated-failure retro derivation, context eval result recording.

- `src/peers/tool-registry.mjs`  
  Tool registry defaults, role permission checks, curated toolset derivation for peer/subagent prompts.

- `src/peers/metrics.mjs`  
  Metrics derived from factory runs, gates, rework, goal board, control ledger, and context patch activity.

- `src/peers/pr-shepherd.mjs`  
  PR lifecycle records, post-merge verification records, command recommendations for `gh`/git without executing by default.

- `src/peers/evals.mjs`  
  Eval manifest defaults, eval result records, task/context/scenario eval summaries.

- `src/peers/automations.mjs`  
  Optional automation catalog, disabled-by-default schedules, automation run ledger.

Modify:

- `src/peers/command.mjs`  
  Add `/peer factory`, `/peer metrics`, extend `/peer context`, extend `/peer do`, update help/completions.

- `src/peers/command-center.mjs`  
  Add factory state, gate/rework/metrics recommendations, and simplified next actions.

- `src/peers/self-improve.mjs`  
  Emit factory run records for self-improvement runs.

- `src/peers/control-ledger.mjs`  
  Optionally project factory run summaries into control state if the command center needs one combined state object.

- `extensions/pi-peer/index.ts`  
  Import new modules, wire command handlers, collect factory/metrics/context/tool state for `/peer center`.

- `README.md`  
  Document simplified factory workflow and advanced command reference.

Create tests:

- `test/peer-factory.test.mjs`
- `test/peer-gates.test.mjs`
- `test/peer-rework.test.mjs`
- `test/peer-plan-adversary.test.mjs`
- `test/peer-context-lifecycle.test.mjs`
- `test/peer-tool-registry.test.mjs`
- `test/peer-metrics.test.mjs`
- `test/peer-pr-shepherd.test.mjs`
- `test/peer-evals.test.mjs`
- `test/peer-automations.test.mjs`

Modify tests:

- `test/peer-command.test.mjs`
- `test/peer-command-center.test.mjs`
- `test/peer-self-improve.test.mjs`
- `test/peer-control-ledger.test.mjs` only if factory state is projected into control state.

---

## Task 1: Factory Ledger Core

**Files:**

- Create: `src/peers/factory.mjs`
- Create: `test/peer-factory.test.mjs`

- [ ] **Step 1: Write factory init and append tests**

Create `test/peer-factory.test.mjs` with:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FACTORY_GATES_FILE,
  FACTORY_REWORK_POLICY_FILE,
  FACTORY_RUNS_FILE,
  appendFactoryRunRecord,
  deriveFactoryState,
  formatFactoryStatus,
  initFactory,
  loadFactoryRuns,
  startFactoryRun,
} from "../src/peers/factory.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-factory-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("factory init creates gate policy, rework policy, and append-only run ledger", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initFactory(root);

    assert.deepEqual(result.created.sort(), [
      FACTORY_GATES_FILE,
      FACTORY_REWORK_POLICY_FILE,
      FACTORY_RUNS_FILE,
    ].sort());

    const gates = JSON.parse(await readFile(join(root, FACTORY_GATES_FILE), "utf8"));
    assert.equal(gates.version, 1);
    assert.equal(gates.gates.some((gate) => gate.id === "test"), true);

    const second = await initFactory(root);
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.includes(FACTORY_RUNS_FILE), true);
  });
});

test("factory run records start, attempts, gates, and terminal status", async (t) => {
  await withRoot(t, async (root) => {
    const run = await startFactoryRun(root, {
      objective: "Improve protocol layer",
      goalId: "goal_123",
      peerId: "planner-a",
      paths: ["src/peers"],
      gates: ["test", "pack"],
      source: "peer-do",
    });

    assert.match(run.runId, /^fac_/);
    await appendFactoryRunRecord(root, { type: "attempt-started", runId: run.runId, attempt: 1, peerId: "worker-a" });
    await appendFactoryRunRecord(root, { type: "gate-result", runId: run.runId, gateId: "test", status: "pass", evidence: "npm test passed" });
    await appendFactoryRunRecord(root, { type: "run-completed", runId: run.runId, status: "verified" });

    const loaded = await loadFactoryRuns(root);
    const state = deriveFactoryState(loaded.records);

    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].status, "verified");
    assert.equal(state.runs[0].attempts.length, 1);
    assert.equal(state.runs[0].gateResults.test.status, "pass");
    assert.match(formatFactoryStatus(state), /verified 1/);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test test/peer-factory.test.mjs
```

Expected: fails because `src/peers/factory.mjs` does not exist.

- [ ] **Step 3: Implement `src/peers/factory.mjs` exports**

Implement these exports:

```js
export const FACTORY_DIR = ".pi/factory";
export const FACTORY_RUNS_FILE = `${FACTORY_DIR}/runs.jsonl`;
export const FACTORY_GATES_FILE = `${FACTORY_DIR}/gates.json`;
export const FACTORY_REWORK_POLICY_FILE = `${FACTORY_DIR}/rework-policy.json`;

export async function initFactory(root, options = {}) {}
export async function startFactoryRun(root, input = {}) {}
export async function appendFactoryRunRecord(root, record = {}) {}
export async function loadFactoryRuns(root) {}
export function deriveFactoryState(records = []) {}
export function formatFactoryStatus(state = {}) {}
export function formatFactoryRun(run = {}) {}
```

Behavior:

- `initFactory()` creates `.pi/factory/`, default `gates.json`, default `rework-policy.json`, and an empty `runs.jsonl`.
- `startFactoryRun()` calls `initFactory()`, appends a `run-started` record, and returns `{ runId, objective, goalId, paths, gates }`.
- `appendFactoryRunRecord()` normalizes every record with `id`, `at`, `type`, and `runId` where required.
- `loadFactoryRuns()` tolerates missing ledger as empty and throws on corrupt non-trailing JSONL.
- `deriveFactoryState()` groups records by `runId`, derives attempts, latest gate result per gate, current status, failures, rework count, and active runs.
- `formatFactoryStatus()` returns compact text suitable for `/peer factory status`.

- [ ] **Step 4: Verify the test passes**

Run:

```bash
node --test test/peer-factory.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/peers/factory.mjs test/peer-factory.test.mjs
git commit -m "feat: add peer factory run ledger"
```

---

## Task 2: Factory Command Parser

**Files:**

- Modify: `src/peers/command.mjs`
- Modify: `test/peer-command.test.mjs`

- [ ] **Step 1: Add parser tests**

Append tests to `test/peer-command.test.mjs`:

```js
test("parses peer factory commands", () => {
  const init = parsePeerCommand("factory init");
  assert.equal(init.subcommand, "factory");
  assert.equal(init.factoryAction, "init");

  const run = parsePeerCommand("factory run Improve protocol --goal goal_123 --path src/peers --gate test --gate pack --source peer-do");
  assert.equal(run.factoryAction, "run");
  assert.equal(run.objective, "Improve protocol");
  assert.equal(run.goalId, "goal_123");
  assert.deepEqual(run.paths, ["src/peers"]);
  assert.deepEqual(run.gates, ["test", "pack"]);
  assert.equal(run.source, "peer-do");

  const gate = parsePeerCommand("factory gate fac_123 test fail --evidence 'unit failure' --failure test");
  assert.equal(gate.factoryAction, "gate");
  assert.equal(gate.runId, "fac_123");
  assert.equal(gate.gateId, "test");
  assert.equal(gate.status, "fail");
  assert.equal(gate.evidence, "unit failure");
  assert.equal(gate.failureType, "test");

  const rework = parsePeerCommand("factory rework fac_123 --reason 'test failed' --owner reviewer-a");
  assert.equal(rework.factoryAction, "rework");
  assert.equal(rework.runId, "fac_123");
  assert.equal(rework.reason, "test failed");
  assert.equal(rework.owner, "reviewer-a");

  const metrics = parsePeerCommand("factory metrics");
  assert.equal(metrics.factoryAction, "metrics");
});
```

- [ ] **Step 2: Run the failing parser test**

Run:

```bash
node --test test/peer-command.test.mjs
```

Expected: fails because `factory` is not a known command.

- [ ] **Step 3: Update `src/peers/command.mjs`**

Changes:

- Add `"factory"` and `"metrics"` to `PEER_COMMANDS`.
- Add factory commands to `formatPeerHelp()`.
- Route `subcommand === "factory"` to `parsePeerFactoryCommand()`.
- Add `metrics` as an alias for `factory metrics`.

Parser behavior:

```text
/peer factory init
/peer factory status [run-id]
/peer factory run <objective> [--goal <goal-id>] [--path <path>] [--gate <id>] [--source <source>]
/peer factory gate <run-id> <gate-id> <pass|fail|skip> [--evidence <text>] [--failure <type>]
/peer factory attempt <run-id> start|finish [--attempt <n>] [--peer <peer-id>] [--summary <text>]
/peer factory rework <run-id> [--reason <text>] [--failure <type>] [--owner <peer-id>]
/peer factory plan-review <goal-id>
/peer factory metrics
```

Validation:

- `factory run` requires objective text.
- `factory gate` requires run id, gate id, and `pass|fail|skip`.
- `factory rework` requires run id.
- `factory status` accepts optional run id.

- [ ] **Step 4: Verify parser tests**

Run:

```bash
node --test test/peer-command.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/peers/command.mjs test/peer-command.test.mjs
git commit -m "feat: parse peer factory commands"
```

---

## Task 3: Factory Extension Handler

**Files:**

- Modify: `extensions/pi-peer/index.ts`
- Modify: `test/peer-command.test.mjs`

- [ ] **Step 1: Add command completion expectation**

Extend the existing command completion coverage if present. If no direct completion test exists, add parser coverage only and verify by inspection that `getArgumentCompletions` includes `"factory"` and `"metrics"`.

- [ ] **Step 2: Wire imports in `extensions/pi-peer/index.ts`**

Import:

```ts
import {
  appendFactoryRunRecord,
  formatFactoryRun,
  formatFactoryStatus,
  initFactory,
  loadFactoryRuns,
  startFactoryRun,
  deriveFactoryState,
} from "../../src/peers/factory.mjs";
```

- [ ] **Step 3: Add handler branch**

Add this branch before peer commands that require `ensureEnabled(runtime)`:

```ts
if (parsed.subcommand === "factory" || parsed.subcommand === "metrics") {
  const text = await handlePeerFactoryCommand(parsed, ctx, runtime);
  await refresh();
  return sendPeerMessage(pi, text);
}
```

Add helper:

```ts
async function handlePeerFactoryCommand(parsed: any, ctx: any, runtime: any) {
  const root = ctx?.cwd || process.cwd();
  const peerId = runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown";
  const action = parsed.subcommand === "metrics" ? "metrics" : parsed.factoryAction || "status";

  if (action === "init") {
    const result = await initFactory(root);
    return [
      "# Factory initialized",
      result.created.length ? `created: ${result.created.join(", ")}` : "created: none",
      result.skipped.length ? `existing: ${result.skipped.join(", ")}` : "existing: none",
    ].join("\n");
  }

  if (action === "run") {
    const run = await startFactoryRun(root, { ...parsed, peerId });
    return formatFactoryRun(run);
  }

  if (action === "gate") {
    await appendFactoryRunRecord(root, {
      type: "gate-result",
      runId: parsed.runId,
      gateId: parsed.gateId,
      status: parsed.status,
      evidence: parsed.evidence,
      failureType: parsed.failureType,
      peerId,
    });
    return formatFactoryStatus(deriveFactoryState((await loadFactoryRuns(root)).records));
  }

  if (action === "attempt") {
    await appendFactoryRunRecord(root, {
      type: parsed.attemptAction === "finish" ? "attempt-finished" : "attempt-started",
      runId: parsed.runId,
      attempt: parsed.attempt,
      peerId: parsed.peerId || peerId,
      summary: parsed.summary,
    });
    return formatFactoryStatus(deriveFactoryState((await loadFactoryRuns(root)).records));
  }

  if (action === "status" || action === "metrics") {
    return formatFactoryStatus(deriveFactoryState((await loadFactoryRuns(root)).records));
  }

  return formatFactoryStatus(deriveFactoryState((await loadFactoryRuns(root)).records));
}
```

- [ ] **Step 4: Run the full peer command parser tests**

Run:

```bash
node --test test/peer-command.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/pi-peer/index.ts test/peer-command.test.mjs
git commit -m "feat: wire peer factory command handler"
```

---

## Task 4: Gate Policy And Gate Results

**Files:**

- Create: `src/peers/gates.mjs`
- Create: `test/peer-gates.test.mjs`
- Modify: `src/peers/factory.mjs`

- [ ] **Step 1: Write gate tests**

Create `test/peer-gates.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_GATE_POLICY,
  deriveGateSummary,
  initGatePolicy,
  loadGatePolicy,
  normalizeGateResult,
} from "../src/peers/gates.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-gates-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("gate policy initializes with deterministic defaults", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initGatePolicy(root);
    assert.equal(result.created.length, 1);

    const policy = await loadGatePolicy(root);
    assert.equal(policy.version, 1);
    assert.equal(policy.gates.find((gate) => gate.id === "test").command, "npm test");
    assert.equal(DEFAULT_GATE_POLICY.gates.some((gate) => gate.phase === "deterministic"), true);
  });
});

test("gate summary marks missing required gates as pending", () => {
  const summary = deriveGateSummary({
    policy: {
      version: 1,
      gates: [
        { id: "test", required: true },
        { id: "pack", required: true },
        { id: "review", required: false },
      ],
    },
    results: {
      test: normalizeGateResult({ gateId: "test", status: "pass", evidence: "passed" }),
      review: normalizeGateResult({ gateId: "review", status: "fail", evidence: "review issue" }),
    },
  });

  assert.equal(summary.requiredPassed, false);
  assert.deepEqual(summary.pendingRequiredGateIds, ["pack"]);
  assert.deepEqual(summary.failedGateIds, ["review"]);
});
```

- [ ] **Step 2: Run the failing gate test**

Run:

```bash
node --test test/peer-gates.test.mjs
```

Expected: fails because `src/peers/gates.mjs` does not exist.

- [ ] **Step 3: Implement `src/peers/gates.mjs`**

Default policy:

```js
export const DEFAULT_GATE_POLICY = Object.freeze({
  version: 1,
  gates: [
    { id: "test", label: "Test suite", phase: "deterministic", command: "npm test", required: true },
    { id: "pack", label: "Package dry run", phase: "deterministic", command: "npm run check:pack", required: true },
    { id: "check", label: "Project check", phase: "deterministic", command: "npm run check", required: false },
    { id: "plan-adversary", label: "Plan adversary", phase: "ai-native", required: true },
    { id: "code-review", label: "Independent code review", phase: "ai-native", required: true },
    { id: "context-judge", label: "Context judge", phase: "ai-native", required: false }
  ]
});
```

Exports:

```js
export async function initGatePolicy(root, options = {}) {}
export async function loadGatePolicy(root) {}
export function normalizeGateResult(input = {}) {}
export function deriveGateSummary(input = {}) {}
export function formatGateSummary(summary = {}) {}
```

Behavior:

- Store policy in `.pi/factory/gates.json`.
- Accept statuses `pass`, `fail`, `skip`, and `pending`.
- Required gates pass only when every required gate has latest status `pass`.
- Failed optional gates are visible in summary but do not block `requiredPassed`.

- [ ] **Step 4: Use gate defaults from `factory.mjs`**

Change `initFactory()` so it delegates gate policy creation to `initGatePolicy()` instead of duplicating gate JSON.

- [ ] **Step 5: Verify tests**

Run:

```bash
node --test test/peer-gates.test.mjs test/peer-factory.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/peers/gates.mjs src/peers/factory.mjs test/peer-gates.test.mjs
git commit -m "feat: add factory verification gate policy"
```

---

## Task 5: Structured Rework Manager

**Files:**

- Create: `src/peers/rework.mjs`
- Create: `test/peer-rework.test.mjs`
- Modify: `src/peers/factory.mjs`
- Modify: `extensions/pi-peer/index.ts`

- [ ] **Step 1: Write rework tests**

Create `test/peer-rework.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REWORK_POLICY,
  deriveReworkDecision,
  normalizeFailureReport,
} from "../src/peers/rework.mjs";

test("failure reports normalize taxonomy and evidence", () => {
  const report = normalizeFailureReport({
    runId: "fac_1",
    failureType: "test",
    summary: "unit test failed",
    evidence: "AssertionError",
    owner: "worker-a",
  });

  assert.equal(report.failureType, "test");
  assert.equal(report.summary, "unit test failed");
  assert.equal(report.owner, "worker-a");
});

test("rework decision escalates after configured max attempts", () => {
  const decision = deriveReworkDecision({
    policy: DEFAULT_REWORK_POLICY,
    run: {
      runId: "fac_1",
      attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }, { attempt: 4 }, { attempt: 5 }],
      failures: [{ failureType: "test", summary: "still failing" }],
    },
  });

  assert.equal(decision.action, "escalate-human");
  assert.match(decision.reason, /maximum rework attempts/i);
});

test("rework decision asks for context patch on repeated same failure", () => {
  const decision = deriveReworkDecision({
    policy: DEFAULT_REWORK_POLICY,
    run: {
      runId: "fac_1",
      attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
      failures: [
        { failureType: "handoff", summary: "missing verification" },
        { failureType: "handoff", summary: "missing verification again" },
        { failureType: "handoff", summary: "still missing verification" },
      ],
    },
  });

  assert.equal(decision.action, "context-patch");
});
```

- [ ] **Step 2: Run the failing rework test**

Run:

```bash
node --test test/peer-rework.test.mjs
```

Expected: fails because `src/peers/rework.mjs` does not exist.

- [ ] **Step 3: Implement `src/peers/rework.mjs`**

Failure taxonomy:

```js
export const FAILURE_TYPES = Object.freeze([
  "plan",
  "test",
  "lint",
  "build",
  "package",
  "review",
  "merge-conflict",
  "handoff",
  "context",
  "tool",
  "timeout",
  "security",
  "unknown"
]);
```

Default policy:

```js
export const DEFAULT_REWORK_POLICY = Object.freeze({
  version: 1,
  maxAttempts: 5,
  repeatedFailureThreshold: 3,
  steps: [
    { attempt: 1, action: "fix-directly" },
    { attempt: 2, action: "root-cause-analysis" },
    { attempt: 3, action: "independent-review" },
    { attempt: 4, action: "context-or-tool-patch" },
    { attempt: 5, action: "escalate-human" }
  ]
});
```

Exports:

```js
export function normalizeFailureReport(input = {}) {}
export function deriveReworkDecision(input = {}) {}
export function formatReworkDecision(decision = {}) {}
```

- [ ] **Step 4: Add factory rework records**

In `factory.mjs`, ensure `deriveFactoryState()` collects:

- `failure-reported`
- `rework-requested`
- `context-patch-requested`
- `human-escalation`

The derived run object should expose:

```js
{
  failures: [],
  reworkCount: 0,
  escalationRequired: false,
  latestReworkDecision: undefined
}
```

- [ ] **Step 5: Wire `/peer factory rework`**

Update `handlePeerFactoryCommand()`:

- Load run state.
- Call `deriveReworkDecision()`.
- Append a `rework-requested`, `context-patch-requested`, or `human-escalation` record.
- Return `formatReworkDecision(decision)` plus `formatFactoryRun(run)`.

- [ ] **Step 6: Verify**

Run:

```bash
node --test test/peer-rework.test.mjs test/peer-factory.test.mjs
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/peers/rework.mjs src/peers/factory.mjs extensions/pi-peer/index.ts test/peer-rework.test.mjs
git commit -m "feat: add structured factory rework policy"
```

---

## Task 6: Plan Contract And Adversarial Review

**Files:**

- Create: `src/peers/plan-adversary.mjs`
- Create: `test/peer-plan-adversary.test.mjs`
- Modify: `src/peers/command.mjs`
- Modify: `extensions/pi-peer/index.ts`
- Modify: `src/peers/command-center.mjs`

- [ ] **Step 1: Write plan adversary tests**

Create `test/peer-plan-adversary.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePlanAdversaryReview,
  formatPlanAdversaryReview,
  normalizePlanContract,
} from "../src/peers/plan-adversary.mjs";

test("plan contract normalizes lanes, dependencies, paths, and gates", () => {
  const plan = normalizePlanContract({
    goalId: "goal_123",
    objective: "Ship factory control plane",
    lanes: ["research", "implementation", "review"],
    paths: ["src/peers/factory.mjs"],
    gates: ["test", "pack"],
  });

  assert.equal(plan.goalId, "goal_123");
  assert.deepEqual(plan.gates, ["test", "pack"]);
  assert.equal(plan.workItems.length, 3);
  assert.deepEqual(plan.workItems[1].dependsOn, [plan.workItems[0].id]);
});

test("adversary blocks write work without paths or verification gates", () => {
  const review = derivePlanAdversaryReview({
    plan: normalizePlanContract({
      goalId: "goal_123",
      objective: "Ship risky change",
      lanes: ["implementation"],
      paths: [],
      gates: [],
    }),
  });

  assert.equal(review.verdict, "block");
  assert.equal(review.findings.some((item) => item.code === "missing-write-paths"), true);
  assert.equal(review.findings.some((item) => item.code === "missing-required-gates"), true);
  assert.match(formatPlanAdversaryReview(review), /block/i);
});

test("adversary flags human approval for high-risk paths", () => {
  const review = derivePlanAdversaryReview({
    plan: normalizePlanContract({
      goalId: "goal_123",
      objective: "Change auth behavior",
      lanes: ["implementation", "review"],
      paths: ["src/auth/session.ts"],
      gates: ["test"],
    }),
  });

  assert.equal(review.requiresHuman, true);
  assert.equal(review.findings.some((item) => item.code === "high-risk-path"), true);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test test/peer-plan-adversary.test.mjs
```

Expected: fails because `src/peers/plan-adversary.mjs` does not exist.

- [ ] **Step 3: Implement `src/peers/plan-adversary.mjs`**

Exports:

```js
export function normalizePlanContract(input = {}) {}
export function derivePlanAdversaryReview(input = {}) {}
export function formatPlanAdversaryReview(review = {}) {}
```

Review findings:

- `missing-objective`
- `missing-write-paths`
- `missing-required-gates`
- `missing-review-lane`
- `dependency-cycle`
- `duplicate-work-key`
- `path-overlap`
- `high-risk-path`
- `needs-human-approval`

High-risk path matchers:

```js
const HIGH_RISK_PATH_PATTERNS = [
  /(^|\/)auth(\/|$)/i,
  /(^|\/)billing(\/|$)/i,
  /(^|\/)payments?(\/|$)/i,
  /(^|\/)migrations?(\/|$)/i,
  /(^|\/)security(\/|$)/i,
  /(^|\/)secrets?(\/|$)/i
];
```

Verdicts:

- `pass`
- `pass-with-risks`
- `block`

- [ ] **Step 4: Wire command parser**

In `src/peers/command.mjs`, ensure:

```text
/peer factory plan-review <goal-id> [--path <path>] [--gate <id>] [--lane <lane>]
/peer do plan <goal-id>
```

`/peer do plan <goal-id>` should route to the factory plan-review path through `routePeerIntent()`.

- [ ] **Step 5: Wire extension handler**

In `handlePeerFactoryCommand()`:

- Load the goal board.
- Build a plan contract from goal objective, current work items/proposals, paths, and parsed gates.
- Run `derivePlanAdversaryReview()`.
- Append a factory record `{ type: "plan-review", goalId, verdict, findings }`.
- If verdict is `block`, append a goal-board `objection` with lane `review`.
- Return `formatPlanAdversaryReview(review)`.

- [ ] **Step 6: Add command center recommendation**

In `derivePeerCommandCenterRecommendations()`:

- If current goal exists and has no plan-review factory record, recommend `/peer do plan <goal-id>`.
- If current goal has a blocking plan review, recommend `/peer do coordinate <goal-id>`.

- [ ] **Step 7: Verify**

Run:

```bash
node --test test/peer-plan-adversary.test.mjs test/peer-command.test.mjs test/peer-command-center.test.mjs
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/peers/plan-adversary.mjs src/peers/command.mjs src/peers/command-center.mjs extensions/pi-peer/index.ts test/peer-plan-adversary.test.mjs test/peer-command.test.mjs test/peer-command-center.test.mjs
git commit -m "feat: add adversarial peer plan review"
```

---

## Task 7: Context-As-Code Lifecycle

**Files:**

- Create: `src/peers/context-lifecycle.mjs`
- Create: `test/peer-context-lifecycle.test.mjs`
- Modify: `src/peers/command.mjs`
- Modify: `extensions/pi-peer/index.ts`

- [ ] **Step 1: Write context lifecycle tests**

Create `test/peer-context-lifecycle.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContextPatch,
  deriveContextLifecycleState,
  formatContextLifecycleStatus,
  loadContextLifecycle,
  recordContextEvalResult,
} from "../src/peers/context-lifecycle.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-context-life-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("context patch ledger records trigger, change, metric, eval, owner, and review date", async (t) => {
  await withRoot(t, async (root) => {
    const patch = await appendContextPatch(root, {
      trigger: "handoff failures repeated",
      change: "Require Verification heading in peer handoffs",
      metric: "missing verification handoff count",
      evalName: "handoff-quality",
      owner: "planner-a",
      reviewDate: "2026-06-24",
    });

    assert.match(patch.patchId, /^ctx_/);

    const state = deriveContextLifecycleState(await loadContextLifecycle(root));
    assert.equal(state.patches.length, 1);
    assert.equal(state.patches[0].owner, "planner-a");
    assert.match(formatContextLifecycleStatus(state), /patches 1/);
  });
});

test("context eval results attach to patch ids", async (t) => {
  await withRoot(t, async (root) => {
    const patch = await appendContextPatch(root, {
      trigger: "review misses",
      change: "Add review checklist",
      metric: "review miss rate",
      evalName: "review-checklist",
      owner: "reviewer-a",
      reviewDate: "2026-06-24",
    });

    await recordContextEvalResult(root, {
      patchId: patch.patchId,
      evalName: "review-checklist",
      status: "pass",
      evidence: "scenario eval passed",
    });

    const state = deriveContextLifecycleState(await loadContextLifecycle(root));
    assert.equal(state.evalResults.length, 1);
    assert.equal(state.patchEvalStatus[patch.patchId], "pass");
  });
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test test/peer-context-lifecycle.test.mjs
```

Expected: fails because `src/peers/context-lifecycle.mjs` does not exist.

- [ ] **Step 3: Implement context lifecycle module**

Exports:

```js
export const CONTEXT_DIR = ".pi/context";
export const CONTEXT_PATCHES_FILE = `${CONTEXT_DIR}/patches.jsonl`;
export const CONTEXT_RETROS_FILE = `${CONTEXT_DIR}/retros.jsonl`;
export const CONTEXT_EVAL_RESULTS_FILE = `${CONTEXT_DIR}/eval-results.jsonl`;

export async function appendContextPatch(root, input = {}) {}
export async function recordContextEvalResult(root, input = {}) {}
export async function appendContextRetro(root, input = {}) {}
export async function loadContextLifecycle(root) {}
export function deriveContextLifecycleState(loaded = {}) {}
export function formatContextLifecycleStatus(state = {}) {}
```

Patch validation:

- `trigger` required.
- `change` required.
- `metric` required.
- `evalName` required.
- `owner` required.
- `reviewDate` required and must parse as a date.

- [ ] **Step 4: Extend `/peer context` parser**

Keep current `/peer context` behavior as budget status.

Add:

```text
/peer context status
/peer context patch --trigger <text> --change <text> --metric <text> --eval <name> --owner <peer-id> --review-date <YYYY-MM-DD>
/peer context eval <patch-id> <pass|fail> --eval <name> --evidence <text>
/peer context retro --summary <text> [--failure <type>] [--run <run-id>]
```

- [ ] **Step 5: Wire extension handler**

In the existing `parsed.subcommand === "context"` branch:

- If no context action, keep the current context budget report.
- If action is lifecycle status, return `formatContextLifecycleStatus()`.
- If action is patch/eval/retro, append records and return lifecycle status.

- [ ] **Step 6: Verify**

Run:

```bash
node --test test/peer-context-lifecycle.test.mjs test/peer-command.test.mjs
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/peers/context-lifecycle.mjs src/peers/command.mjs extensions/pi-peer/index.ts test/peer-context-lifecycle.test.mjs test/peer-command.test.mjs
git commit -m "feat: add peer context lifecycle ledger"
```

---

## Task 8: Tool Registry And Curated Toolsets

**Files:**

- Create: `src/peers/tool-registry.mjs`
- Create: `test/peer-tool-registry.test.mjs`
- Modify: `src/peers/subagents.mjs`
- Modify: `src/peers/guidance.mjs`

- [ ] **Step 1: Write tool registry tests**

Create `test/peer-tool-registry.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TOOL_REGISTRY,
  deriveToolsetForRole,
  initToolRegistry,
  loadToolRegistry,
  toolAllowedForRole,
} from "../src/peers/tool-registry.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-tools-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("tool registry initializes without yaml dependency", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initToolRegistry(root);
    assert.equal(result.created.length, 1);

    const registry = await loadToolRegistry(root);
    assert.equal(registry.version, 1);
    assert.equal(registry.tools.some((tool) => tool.id === "peer_send"), true);
  });
});

test("tool registry derives role-specific curated tools", () => {
  const toolset = deriveToolsetForRole(DEFAULT_TOOL_REGISTRY, {
    role: "reviewer",
    domain: "protocol",
  });

  assert.equal(toolset.some((tool) => tool.id === "peer_get"), true);
  assert.equal(toolAllowedForRole(DEFAULT_TOOL_REGISTRY, "peer_send", "reviewer"), true);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test test/peer-tool-registry.test.mjs
```

Expected: fails because `src/peers/tool-registry.mjs` does not exist.

- [ ] **Step 3: Implement registry module**

Use JSON, not YAML, to keep the package dependency-free:

```js
export const TOOL_REGISTRY_DIR = ".pi/tools";
export const TOOL_REGISTRY_FILE = `${TOOL_REGISTRY_DIR}/registry.json`;
```

Default registry shape:

```js
export const DEFAULT_TOOL_REGISTRY = Object.freeze({
  version: 1,
  tools: [
    {
      id: "peer_list",
      risk: "low",
      roles: ["planner", "coordinator", "reviewer", "researcher", "implementer"],
      permissions: ["read-peer-state"],
      failureModes: ["stale-discovery"]
    },
    {
      id: "peer_send",
      risk: "medium",
      roles: ["planner", "coordinator", "reviewer"],
      permissions: ["delegate-peer-task"],
      failureModes: ["duplicate-work", "stale-task", "unavailable-peer"]
    },
    {
      id: "peer_get",
      risk: "low",
      roles: ["planner", "coordinator", "reviewer", "researcher", "implementer"],
      permissions: ["read-peer-state"],
      failureModes: ["large-context"]
    },
    {
      id: "peer_progress",
      risk: "low",
      roles: ["planner", "coordinator", "reviewer", "researcher", "implementer"],
      permissions: ["report-progress"],
      failureModes: ["missing-inbound-task"]
    }
  ]
});
```

Exports:

```js
export async function initToolRegistry(root, options = {}) {}
export async function loadToolRegistry(root) {}
export function deriveToolsetForRole(registry, input = {}) {}
export function toolAllowedForRole(registry, toolId, role) {}
export function formatToolRegistryStatus(registry = {}) {}
```

- [ ] **Step 4: Use registry in subagent prompt metadata**

In `src/peers/subagents.mjs`, include curated toolset ids in `subrunMetadata()` when `input.role` or `input.parentPeerRole` is present.

Do not block existing subrun behavior when the registry file is missing.

- [ ] **Step 5: Verify**

Run:

```bash
node --test test/peer-tool-registry.test.mjs test/peer-subagents.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/peers/tool-registry.mjs src/peers/subagents.mjs src/peers/guidance.mjs test/peer-tool-registry.test.mjs
git commit -m "feat: add peer tool registry"
```

---

## Task 9: Metrics Dashboard

**Files:**

- Create: `src/peers/metrics.mjs`
- Create: `test/peer-metrics.test.mjs`
- Modify: `src/peers/command-center.mjs`
- Modify: `extensions/pi-peer/index.ts`

- [ ] **Step 1: Write metrics tests**

Create `test/peer-metrics.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePeerFactoryMetrics,
  formatPeerFactoryMetrics,
} from "../src/peers/metrics.mjs";

test("metrics summarize autonomy, gates, rework, escalation, and context patches", () => {
  const metrics = derivePeerFactoryMetrics({
    factoryState: {
      runs: [
        { runId: "fac_1", status: "verified", attempts: [{ attempt: 1 }], gateResults: { test: { status: "pass" } } },
        { runId: "fac_2", status: "human-escalation", attempts: [{ attempt: 1 }, { attempt: 2 }], gateResults: { test: { status: "fail" } }, escalationRequired: true },
      ],
    },
    contextState: {
      patches: [{ patchId: "ctx_1" }],
      evalResults: [{ status: "pass" }],
    },
  });

  assert.equal(metrics.totalRuns, 2);
  assert.equal(metrics.verifiedRuns, 1);
  assert.equal(metrics.autonomyRate, 0.5);
  assert.equal(metrics.escalationRate, 0.5);
  assert.equal(metrics.contextPatchCount, 1);
  assert.match(formatPeerFactoryMetrics(metrics), /autonomy rate: 50%/i);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node --test test/peer-metrics.test.mjs
```

Expected: fails because `src/peers/metrics.mjs` does not exist.

- [ ] **Step 3: Implement metrics module**

Exports:

```js
export function derivePeerFactoryMetrics(input = {}) {}
export function formatPeerFactoryMetrics(metrics = {}) {}
```

Metrics:

- `totalRuns`
- `verifiedRuns`
- `failedRuns`
- `activeRuns`
- `autonomyRate`
- `gatePassRate`
- `averageReworkHops`
- `escalationRate`
- `contextPatchCount`
- `contextEvalPassRate`
- `openGoalCount`
- `activeTaskCount`
- `activeSubrunCount`

- [ ] **Step 4: Add command center metrics block**

In `buildPeerCommandCenterState()`:

- Accept `factoryState`, `contextState`, and `metrics`.
- Include compact metrics in returned state.

In `formatPeerCommandCenter()`:

Add one line:

```text
Factory: runs <n> · verified <n> · autonomy <percent> · rework avg <n> · escalations <n>
```

In recommendations:

- If any active run has failed required gates, recommend `/peer do rework <run-id>`.
- If no factory initialized, recommend `/peer factory init`.
- If metrics show repeated context failures, recommend `/peer context retro`.

- [ ] **Step 5: Wire extension collection**

In `collectPeerCommandCenterInput()`:

- Load factory runs.
- Derive factory state.
- Load context lifecycle.
- Derive metrics.
- Pass into command center state.

- [ ] **Step 6: Verify**

Run:

```bash
node --test test/peer-metrics.test.mjs test/peer-command-center.test.mjs
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/peers/metrics.mjs src/peers/command-center.mjs extensions/pi-peer/index.ts test/peer-metrics.test.mjs test/peer-command-center.test.mjs
git commit -m "feat: surface peer factory metrics"
```

---

## Task 10: Integrate Factory Runs With Existing Workflows

**Files:**

- Modify: `src/peers/command-center.mjs`
- Modify: `src/peers/self-improve.mjs`
- Modify: `extensions/pi-peer/index.ts`
- Modify: `test/peer-command-center.test.mjs`
- Modify: `test/peer-self-improve.test.mjs`

- [ ] **Step 1: Add self-improve factory record test**

Extend `test/peer-self-improve.test.mjs`:

```js
test("self-improve run can emit factory metadata", async (t) => {
  await withRoot(t, async (root) => {
    const result = await startSelfImproveRun(root, {
      objective: "Improve verification",
      loops: 1,
      peerId: "planner",
      factory: true,
    });

    assert.equal(result.factory?.source, "self-improve");
    assert.equal(result.factory?.objective, "Improve verification");
  });
});
```

- [ ] **Step 2: Update `startSelfImproveRun()`**

Add optional `input.factory === true`.

When enabled, include returned metadata:

```js
factory: {
  source: "self-improve",
  objective,
  gates: evals,
  paths,
  runId: undefined
}
```

Do not append factory records from inside `self-improve.mjs` unless `factory.mjs` is imported. Prefer appending in the extension handler to keep module boundaries simple.

- [ ] **Step 3: Append factory run in extension self-improve handler**

In `handlePeerSelfImproveCommand()` after `startSelfImproveRun()`:

- Call `startFactoryRun(root, { objective: parsed.objective, goalId: result.goalId, peerId, paths: result.paths, gates: result.evals, source: "self-improve" })`.
- Append a factory record linking `selfImprove.runId`.
- Add `factoryRunId` to formatted output.

- [ ] **Step 4: Integrate `/peer do start goal`**

In `routePeerIntent()` or its extension caller:

- When a goal is created through `/peer do start goal`, create a factory run with `source: "peer-do"`.
- Seed plan-review recommendation.

The command result should include:

```text
Factory run: <run-id>
Next: /peer do plan <goal-id>
```

- [ ] **Step 5: Verify**

Run:

```bash
node --test test/peer-self-improve.test.mjs test/peer-command-center.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/peers/self-improve.mjs src/peers/command-center.mjs extensions/pi-peer/index.ts test/peer-self-improve.test.mjs test/peer-command-center.test.mjs
git commit -m "feat: link peer workflows to factory runs"
```

---

## Task 11: Eval Suite Manifests

**Files:**

- Create: `src/peers/evals.mjs`
- Create: `test/peer-evals.test.mjs`
- Modify: `src/peers/context-lifecycle.mjs`

- [ ] **Step 1: Write eval tests**

Create `test/peer-evals.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_EVAL_MANIFESTS,
  deriveEvalSuiteSummary,
  initEvalManifests,
  loadEvalManifests,
} from "../src/peers/evals.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-evals-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("eval manifests initialize task, context, and scenario suites", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initEvalManifests(root);
    assert.equal(result.created.length, 3);

    const manifests = await loadEvalManifests(root);
    assert.equal(manifests.task.version, 1);
    assert.equal(manifests.context.version, 1);
    assert.equal(manifests.scenario.version, 1);
    assert.equal(DEFAULT_EVAL_MANIFESTS.scenario.evals.some((item) => item.id === "peer-factory-run"), true);

    const summary = deriveEvalSuiteSummary(manifests);
    assert.equal(summary.totalEvalCount > 0, true);
  });
});
```

- [ ] **Step 2: Run failing eval tests**

Run:

```bash
node --test test/peer-evals.test.mjs
```

Expected: fails because `src/peers/evals.mjs` does not exist.

- [ ] **Step 3: Implement eval manifests**

Files:

```js
export const EVALS_DIR = ".pi/evals";
export const TASK_EVALS_FILE = `${EVALS_DIR}/task-evals.json`;
export const CONTEXT_EVALS_FILE = `${EVALS_DIR}/context-evals.json`;
export const SCENARIO_EVALS_FILE = `${EVALS_DIR}/scenario-evals.json`;
```

Default eval IDs:

- `peer-factory-run`
- `gate-failure-rework`
- `plan-adversary-blocks-risk`
- `context-patch-requires-eval`
- `tool-registry-role-filter`
- `command-center-next-action`

Exports:

```js
export async function initEvalManifests(root, options = {}) {}
export async function loadEvalManifests(root) {}
export function deriveEvalSuiteSummary(manifests = {}) {}
export function formatEvalSuiteSummary(summary = {}) {}
```

- [ ] **Step 4: Connect context eval names**

In `context-lifecycle.mjs`, add helper:

```js
export function contextPatchHasPassingEval(state, patchId) {}
```

This will support future promotion rules.

- [ ] **Step 5: Verify**

Run:

```bash
node --test test/peer-evals.test.mjs test/peer-context-lifecycle.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/peers/evals.mjs src/peers/context-lifecycle.mjs test/peer-evals.test.mjs test/peer-context-lifecycle.test.mjs
git commit -m "feat: add peer eval manifests"
```

---

## Task 12: PR Shepherd And Post-Merge Verification Records

**Files:**

- Create: `src/peers/pr-shepherd.mjs`
- Create: `test/peer-pr-shepherd.test.mjs`
- Modify: `src/peers/command.mjs`
- Modify: `extensions/pi-peer/index.ts`

- [ ] **Step 1: Write PR shepherd tests**

Create `test/peer-pr-shepherd.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePrShepherdCommands,
  derivePrShepherdState,
  formatPrShepherdStatus,
  normalizePrRecord,
} from "../src/peers/pr-shepherd.mjs";

test("pr records normalize lifecycle state", () => {
  const record = normalizePrRecord({
    runId: "fac_1",
    goalId: "goal_1",
    action: "created",
    prUrl: "https://github.com/example/repo/pull/1",
    status: "open",
  });

  assert.equal(record.status, "open");
  assert.equal(record.runId, "fac_1");
});

test("pr shepherd recommends commands without executing them", () => {
  const commands = derivePrShepherdCommands({
    branch: "feature/factory",
    remote: "origin",
    title: "Add factory control plane",
    body: "Verification-first control plane.",
  });

  assert.equal(commands.some((command) => command.includes("gh pr create")), true);
  assert.equal(commands.some((command) => command.includes("git push")), true);
});

test("pr shepherd state surfaces post-merge verification need", () => {
  const state = derivePrShepherdState([
    normalizePrRecord({ runId: "fac_1", action: "merged", status: "merged", prUrl: "https://github.com/example/repo/pull/1" }),
  ]);

  assert.equal(state.needsPostMergeVerification.length, 1);
  assert.match(formatPrShepherdStatus(state), /post-merge/i);
});
```

- [ ] **Step 2: Run failing PR tests**

Run:

```bash
node --test test/peer-pr-shepherd.test.mjs
```

Expected: fails because `src/peers/pr-shepherd.mjs` does not exist.

- [ ] **Step 3: Implement PR shepherd module**

Exports:

```js
export const PR_SHEPHERD_FILE = ".pi/factory/pr-shepherd.jsonl";

export function normalizePrRecord(input = {}) {}
export async function appendPrRecord(root, input = {}) {}
export async function loadPrRecords(root) {}
export function derivePrShepherdState(records = []) {}
export function derivePrShepherdCommands(input = {}) {}
export function formatPrShepherdStatus(state = {}) {}
```

Rules:

- Never execute `git`, `gh`, or network commands in this module.
- Generate suggested commands as text.
- Record user/agent-supplied lifecycle events: `created`, `ci-failed`, `ci-passed`, `merged`, `post-merge-verified`, `stale`, `closed`.

- [ ] **Step 4: Add command parser**

Add:

```text
/peer factory pr status
/peer factory pr record <created|ci-failed|ci-passed|merged|post-merge-verified|stale|closed> --run <run-id> [--url <pr-url>] [--evidence <text>]
/peer factory pr commands --title <title> --body <body> [--branch <branch>] [--remote <remote>]
```

- [ ] **Step 5: Wire extension handler**

In `handlePeerFactoryCommand()`:

- Dispatch `factoryAction === "pr"` to PR shepherd helper.
- Return status or suggested commands.

- [ ] **Step 6: Verify**

Run:

```bash
node --test test/peer-pr-shepherd.test.mjs test/peer-command.test.mjs
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/peers/pr-shepherd.mjs src/peers/command.mjs extensions/pi-peer/index.ts test/peer-pr-shepherd.test.mjs test/peer-command.test.mjs
git commit -m "feat: add peer pr shepherd records"
```

---

## Task 13: Optional Automation Catalog

**Files:**

- Create: `src/peers/automations.mjs`
- Create: `test/peer-automations.test.mjs`
- Modify: `src/peers/command.mjs`
- Modify: `extensions/pi-peer/index.ts`

- [ ] **Step 1: Write automation tests**

Create `test/peer-automations.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_AUTOMATION_CATALOG,
  deriveAutomationStatus,
  initAutomationCatalog,
  loadAutomationCatalog,
  normalizeAutomationRun,
} from "../src/peers/automations.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-automations-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("automation catalog initializes disabled by default", async (t) => {
  await withRoot(t, async (root) => {
    await initAutomationCatalog(root);
    const catalog = await loadAutomationCatalog(root);
    assert.equal(catalog.automations.every((item) => item.enabled === false), true);
    assert.equal(DEFAULT_AUTOMATION_CATALOG.automations.some((item) => item.id === "automation-auditor"), true);
  });
});

test("automation status counts enabled and recent runs", () => {
  const status = deriveAutomationStatus({
    catalog: {
      automations: [
        { id: "feature-planner", enabled: true },
        { id: "bug-fixer", enabled: false },
      ],
    },
    runs: [
      normalizeAutomationRun({ automationId: "feature-planner", status: "done" }),
    ],
  });

  assert.equal(status.enabledCount, 1);
  assert.equal(status.runCount, 1);
});
```

- [ ] **Step 2: Run failing automation tests**

Run:

```bash
node --test test/peer-automations.test.mjs
```

Expected: fails because `src/peers/automations.mjs` does not exist.

- [ ] **Step 3: Implement automation module**

Default disabled catalog IDs:

- `feature-planner`
- `feature-builder`
- `bug-fixer`
- `pr-reviewer`
- `post-merge-verifier`
- `ui-verifier`
- `pr-shepherd`
- `stale-issue-reviewer`
- `needs-human-requeue`
- `incident-responder`
- `performance-monitor`
- `feedback-digest`
- `product-improver`
- `daily-metrics`
- `weekly-recap`
- `automation-auditor`

Exports:

```js
export async function initAutomationCatalog(root, options = {}) {}
export async function loadAutomationCatalog(root) {}
export async function appendAutomationRun(root, input = {}) {}
export function normalizeAutomationRun(input = {}) {}
export function deriveAutomationStatus(input = {}) {}
export function formatAutomationStatus(status = {}) {}
```

- [ ] **Step 4: Add command parser**

Add:

```text
/peer factory automate status
/peer factory automate init
/peer factory automate run <automation-id> --goal <goal-id> [--dry-run]
/peer factory automate record <automation-id> <done|blocked|error> --evidence <text>
```

All automations remain record/recommendation-only unless a future approved runner is explicitly added.

- [ ] **Step 5: Wire extension handler**

Handle `factory automate` under `handlePeerFactoryCommand()`.

- [ ] **Step 6: Verify**

Run:

```bash
node --test test/peer-automations.test.mjs test/peer-command.test.mjs
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/peers/automations.mjs src/peers/command.mjs extensions/pi-peer/index.ts test/peer-automations.test.mjs test/peer-command.test.mjs
git commit -m "feat: add optional peer automation catalog"
```

---

## Task 14: Setup Wizard And Command Center Simplification

**Files:**

- Modify: `src/peers/setup-wizard.mjs`
- Modify: `src/peers/command-center.mjs`
- Modify: `test/peer-setup-wizard.test.mjs`
- Modify: `test/peer-command-center.test.mjs`

- [ ] **Step 1: Add setup wizard choices**

Extend `/peer setup <choice>` so the wizard asks what the session should use:

1. Coordinate peers
2. Implement code
3. Review work
4. Research
5. Manage private subagents
6. Run factory verification
7. Improve context
8. Shepherd PRs
9. Inspect status only

The choices should configure:

- peer role/domain
- whether subagents are enabled
- whether factory artifacts are initialized
- whether tool registry is initialized
- whether automations remain disabled

- [ ] **Step 2: Add setup tests**

Extend `test/peer-setup-wizard.test.mjs`:

```js
test("setup choice factory initializes verification-oriented peer profile", async (t) => {
  await withRoot(t, async (root) => {
    const result = await applyPeerSetupChoice(root, {
      choice: "factory",
      peerId: "verifier-a",
    });

    assert.equal(result.peerId, "verifier-a");
    assert.equal(result.role, "verifier");
    assert.equal(result.domain, "verification");
    assert.equal(result.nextCommands.some((command) => command.includes("/peer center")), true);
  });
});
```

- [ ] **Step 3: Update command center recommendations**

`/peer center` should recommend exactly one primary next action first:

- Setup missing: `/peer setup`
- Active failed gate: `/peer do rework <run-id>`
- Current goal missing plan review: `/peer do plan <goal-id>`
- Current goal ready for verification: `/peer do verify <goal-id>`
- Active subrun: `/peer subrun status`
- No goal: `/peer do start goal "<objective>"`
- Stable state: `/peer do metrics`

- [ ] **Step 4: Verify**

Run:

```bash
node --test test/peer-setup-wizard.test.mjs test/peer-command-center.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/peers/setup-wizard.mjs src/peers/command-center.mjs test/peer-setup-wizard.test.mjs test/peer-command-center.test.mjs
git commit -m "feat: simplify peer factory setup workflow"
```

---

## Task 15: `/peer do` Facade For Factory Workflows

**Files:**

- Modify: `src/peers/command.mjs`
- Modify: `src/peers/command-center.mjs`
- Modify: `extensions/pi-peer/index.ts`
- Modify: `test/peer-command.test.mjs`
- Modify: `test/peer-command-center.test.mjs`

- [ ] **Step 1: Add parser coverage**

Extend `test/peer-command.test.mjs`:

```js
test("parses peer do factory facade intents", () => {
  const plan = parsePeerCommand("do plan goal_123");
  assert.equal(plan.intent, "plan");
  assert.deepEqual(plan.intentArgs, ["goal_123"]);

  const verify = parsePeerCommand("do verify goal_123 --gate test --gate pack");
  assert.equal(verify.intent, "verify");
  assert.deepEqual(verify.gates, ["test", "pack"]);

  const rework = parsePeerCommand("do rework fac_123");
  assert.equal(rework.intent, "rework");
  assert.deepEqual(rework.intentArgs, ["fac_123"]);

  const metrics = parsePeerCommand("do metrics");
  assert.equal(metrics.intent, "metrics");
});
```

- [ ] **Step 2: Update valid intents**

In `parsePeerDoCommand()`, add:

```js
"plan", "verify", "rework", "metrics", "ship", "automate"
```

Also parse `--gate` into `gates`.

- [ ] **Step 3: Route facade intents**

In `routePeerIntent()`:

- `plan <goal-id>` returns `/peer factory plan-review <goal-id>`.
- `verify <goal-id>` returns `/peer factory run "Verify <goal-id>" --goal <goal-id> --gate ...`.
- `rework <run-id>` returns `/peer factory rework <run-id>`.
- `metrics` returns `/peer factory metrics`.
- `ship <run-id>` returns `/peer factory pr status` and PR command suggestions.
- `automate` returns `/peer factory automate status`.

Do not run advanced commands from `routePeerIntent()` directly. Return the exact next command so the user remains in control.

- [ ] **Step 4: Verify**

Run:

```bash
node --test test/peer-command.test.mjs test/peer-command-center.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/peers/command.mjs src/peers/command-center.mjs extensions/pi-peer/index.ts test/peer-command.test.mjs test/peer-command-center.test.mjs
git commit -m "feat: add peer do factory facade"
```

---

## Task 16: Documentation

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add README section**

Add a section after "Simplified command center workflow":

```md
## Verification-first factory workflow

The factory workflow turns peer collaboration into structured, reviewable runs:

1. `/peer setup`
2. `/peer center`
3. `/peer do start goal "Objective"`
4. `/peer do plan <goal-id>`
5. `/peer do verify <goal-id>`
6. `/peer do rework <run-id>` when gates fail
7. `/peer do metrics`

Factory state is stored locally under `.pi/factory/`. It records run starts, attempts, gate results, rework decisions, plan reviews, PR lifecycle records, and metrics snapshots. The default behavior is record-and-recommend; automatic shell execution and PR operations require explicit future opt-in.
```

- [ ] **Step 2: Add advanced command reference**

Document:

```text
/peer factory init
/peer factory status
/peer factory run
/peer factory gate
/peer factory rework
/peer factory plan-review
/peer factory metrics
/peer context patch
/peer context eval
/peer factory pr status
/peer factory automate status
```

- [ ] **Step 3: Update AGENTS.md**

Add a short "Verification-first factory" note:

```md
Use `/peer factory status` and `/peer do metrics` before closing substantial peer work. Failed gates should become `/peer factory rework` records, not blind retries. Repeated failures should become `/peer context patch` proposals with eval evidence.
```

- [ ] **Step 4: Verify package docs are included**

Run:

```bash
npm run check:pack
```

Expected: dry-run package includes README and source files.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document peer factory workflow"
```

---

## Task 17: Full Verification And Release Readiness

**Files:**

- No planned source changes.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --test test/peer-factory.test.mjs test/peer-gates.test.mjs test/peer-rework.test.mjs test/peer-plan-adversary.test.mjs test/peer-context-lifecycle.test.mjs test/peer-tool-registry.test.mjs test/peer-metrics.test.mjs test/peer-pr-shepherd.test.mjs test/peer-evals.test.mjs test/peer-automations.test.mjs
```

Expected: pass.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: all `test/peer-*.test.mjs` tests pass.

- [ ] **Step 3: Run package check**

Run:

```bash
npm run check:pack
```

Expected: dry-run package succeeds and includes new `src/peers/*.mjs` files.

- [ ] **Step 4: Run full project check**

Run:

```bash
npm run check
```

Expected: `npm test` and `npm run check:pack` pass.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intended files are modified.

- [ ] **Step 6: Final commit if verification required changes**

If verification required fixes, commit them:

```bash
git add src/peers extensions/pi-peer test README.md AGENTS.md
git commit -m "fix: stabilize peer factory workflow"
```

---

## Acceptance Criteria

- `/peer setup` includes factory/session choices without forcing users to learn advanced commands.
- `/peer center` shows factory status and one clear primary next action.
- `/peer do` can guide users through plan, verify, rework, metrics, ship, and automation status.
- `/peer factory` provides advanced control over runs, gates, rework, plan review, metrics, PR records, and automations.
- Every substantial peer workflow can create or link to a factory run.
- Gate failures become structured failure/rework records.
- Repeated failures trigger context patch recommendations.
- Plan review can block risky or under-specified work before execution.
- Tool registry can derive role-specific curated toolsets for peers/subagents.
- Metrics expose autonomy rate, gate pass rate, rework hops, escalation rate, and context patch activity.
- PR shepherd and automation catalog are record/recommendation-only by default.
- Tests cover every new module and command parser change.
- `npm test`, `npm run check:pack`, and `npm run check` pass.

## Self-Review

Spec coverage:

- Factory run ledger: Task 1 through Task 3.
- Verification gates: Task 4.
- Rework manager: Task 5.
- Plan adversary: Task 6.
- Context lifecycle: Task 7.
- Tool registry: Task 8.
- Metrics dashboard: Task 9.
- Integration with current workflows: Task 10 and Task 15.
- Eval suites: Task 11.
- PR shepherd: Task 12.
- Automation catalog: Task 13.
- Setup wizard simplification: Task 14.
- Documentation and verification: Task 16 and Task 17.

Type consistency:

- Factory run ids use `runId`.
- Context patches use `patchId`.
- Gates use `gateId`.
- PR records use `prUrl`.
- Automations use `automationId`.
- Goal links use existing `goalId`.

Risk controls:

- No automatic shell execution is introduced by this plan.
- PR shepherd emits suggested commands and records supplied evidence.
- Automations are disabled by default.
- Runtime artifacts live under `.pi/`.
- The command center remains the primary UX, avoiding command overload.

