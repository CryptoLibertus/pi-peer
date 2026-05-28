# Stigmergic Signal Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure, decay-weighted stigmergic signal field — derived from each goal's existing event stream — that biases scout routing so peer coordination (anti-dogpile, trail reinforcement, stuck-work surfacing) emerges from local traces with no new event type and no new writes.

**Architecture:** A new pure function `derivePeerGoalSignalField(goal|state, options)` walks the projected goal state (`deriveGoalState`) and turns existing events into decayed deposits across three channels — **attractant**, **repellent**, **frustration** — keyed by lane and (when present) path. The scout pressure annotator gains a clamped, mode-modulated field term, so `/peer goal scout` ordering and the idle-watcher inherit the steering for free. A read-only `/peer goal field <id>` view and three factory metrics make the emergence observable.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`. No new dependencies. All field math is deterministic given an injected `nowMs`.

**Spec:** `docs/superpowers/specs/2026-05-28-stigmergic-signal-field-design.md`

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/peers/goal-board.mjs` | Field constants, `derivePeerGoalSignalField`, `formatPeerGoalSignalField`, `scoutFieldAdjust`, scout-pressure integration | Modify |
| `src/peers/command.mjs` | Parse `/peer goal field <id>` + `/peer field` alias | Modify |
| `extensions/pi-peer/index.ts` | Execute the `field` goal action; argument completion | Modify |
| `src/peers/metrics.mjs` | `derivePeerSignalFieldMetrics` + metrics line | Modify |
| `test/peer-goal-board.test.mjs` | Field derivation, routing, view, command-parse tests | Modify |
| `test/peer-metrics.test.mjs` | Signal-field metrics test | Modify |
| `README.md` | One bullet documenting the field | Modify |

All field reads are pure and side-effect-free, mirroring `deriveGoalState`. The deposit/decay logic, the routing modulation, and the view are each isolated helpers so they can be tested independently.

---

## Task 1: Signal-field constants and config resolver

**Files:**
- Modify: `src/peers/goal-board.mjs` (add constants after `SCOUT_PRESSURE_MAX_DECAY` at line 47; add helpers near other module-private helpers, e.g. before `function compareScoutSuggestions` ~line 1440)
- Test: `test/peer-goal-board.test.mjs`

- [ ] **Step 1: Add the constants block**

Add immediately after line 47 (`const SCOUT_PRESSURE_MAX_DECAY = 30;`):

```js
const SIGNAL_FIELD = Object.freeze({
  enabled: true,
  halfLifeMs: 45 * 60 * 1000,
  weights: Object.freeze({ attract: 1, repel: 1, frustration: 1.2 }),
  maxAdjust: 18,
  repelReadDamping: 0.25,
  typeWeights: Object.freeze({
    finding: 3,
    vote: 4,
    taskComplete: 5,
    resolve: 2,
    claimWrite: 5,
    claimRead: 2,
    activeTask: 4,
    staleClaim: 4,
    expiredClaim: 3,
    failedVote: 5,
    blockingObjection: 4,
    handoff: 5,
  }),
});
```

- [ ] **Step 2: Add the config resolver and rounding helper**

Add these module-private helpers (place them just above `function compareScoutSuggestions(a = {}, b = {})` near line 1440):

```js
function resolveSignalFieldConfig(override = {}) {
  if (!override || typeof override !== "object") return SIGNAL_FIELD;
  return {
    enabled: override.enabled === undefined ? SIGNAL_FIELD.enabled : override.enabled !== false,
    halfLifeMs: positiveNumber(override.halfLifeMs) || SIGNAL_FIELD.halfLifeMs,
    weights: { ...SIGNAL_FIELD.weights, ...(override.weights || {}) },
    maxAdjust: positiveNumber(override.maxAdjust) || SIGNAL_FIELD.maxAdjust,
    repelReadDamping: Number.isFinite(override.repelReadDamping) ? override.repelReadDamping : SIGNAL_FIELD.repelReadDamping,
    typeWeights: { ...SIGNAL_FIELD.typeWeights, ...(override.typeWeights || {}) },
  };
}

function roundSignal(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
```

(`positiveNumber` already exists in this module and is used by `projectClaimSummary`.)

- [ ] **Step 3: Write a failing test that the resolver is wired (indirect)**

We cannot test private helpers directly; Task 2 introduces the public `derivePeerGoalSignalField`. Skip a direct test here — proceed to Task 2 which exercises these helpers. (No commit yet.)

- [ ] **Step 4: Commit the scaffolding**

```bash
git add src/peers/goal-board.mjs
git commit -m "feat(goal-board): add signal-field constants and config resolver"
```

---

## Task 2: `derivePeerGoalSignalField` core (deposits + decay)

**Files:**
- Modify: `src/peers/goal-board.mjs` (add exported function after `deriveGoalState`, i.e. after line 311; add deposit helpers near the other private helpers)
- Test: `test/peer-goal-board.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `test/peer-goal-board.test.mjs`. First update the import line at the top to add `derivePeerGoalSignalField`:

```js
import { appendPeerGoalEvent, beginPeerGoalTask, closePeerGoal, completePeerGoalTask, createPeerGoal, deriveGoalState, derivePeerGoalScoutSuggestions, derivePeerGoalSignalField, derivePeerGoalWorkKey, formatPeerGoal, formatPeerGoalList, formatPeerGoalScout, formatPeerGoalSignalField, loadPeerGoalBoard, projectSubagentEvidence, recordPeerGoalTaskDispatch, validateGoalReadyToClose } from "../src/peers/goal-board.mjs";
```

Then add these tests (use plain goal literals — the function is pure and accepts a raw goal):

```js
const HOUR = 60 * 60 * 1000;

function fieldGoal(events) {
  return { id: "g1", objective: "field test", status: "open", createdAt: "2026-05-28T00:00:00.000Z", updatedAt: "2026-05-28T00:00:00.000Z", events };
}

test("signal field deposits attractant from findings and passing votes", () => {
  const nowMs = Date.parse("2026-05-28T01:00:00.000Z");
  const at = "2026-05-28T00:30:00.000Z";
  const field = derivePeerGoalSignalField(
    fieldGoal([
      { id: "f1", type: "finding", peerId: "r1", lane: "research", at, summary: "found" },
      { id: "v1", type: "vote", peerId: "rev1", lane: "review", verdict: "pass", at, summary: "lgtm" },
    ]),
    { nowMs },
  );
  assert.ok(field.lanes.research.attract > 0, "research lane has attractant");
  assert.ok(field.lanes.review.attract > 0, "review lane has attractant");
  assert.equal(field.lanes.research.repel, 0);
  assert.equal(field.lanes.research.frustration, 0);
});

test("signal field deposits repellent from active write claims, heavier than read", () => {
  const nowMs = Date.parse("2026-05-28T00:10:00.000Z");
  const at = "2026-05-28T00:00:00.000Z";
  const field = derivePeerGoalSignalField(
    fieldGoal([
      { id: "c1", type: "claim", peerId: "w1", mode: "write", lane: "implementation", paths: ["src/a.mjs"], at, summary: "edit a" },
      { id: "c2", type: "claim", peerId: "w2", mode: "read", lane: "review", at, summary: "read b" },
    ]),
    { nowMs },
  );
  assert.ok(field.lanes.implementation.repel > field.lanes.review.repel, "write claim repels more than read");
  assert.ok(field.paths["src/a.mjs"].repel > 0, "path-level repellent recorded");
  assert.equal(field.paths["src/a.mjs"].lane, "implementation");
});

test("signal field deposits frustration from stale claims", () => {
  // claim made long ago, no heartbeat, default stale = 45m, so it is stale by now
  const nowMs = Date.parse("2026-05-28T02:00:00.000Z");
  const field = derivePeerGoalSignalField(
    fieldGoal([
      { id: "c1", type: "claim", peerId: "w1", mode: "write", lane: "implementation", at: "2026-05-28T00:00:00.000Z", summary: "stuck" },
    ]),
    { nowMs },
  );
  assert.ok(field.lanes.implementation.frustration > 0, "stale claim produces frustration");
});

test("signal field decays older deposits below identical recent ones", () => {
  const at = "2026-05-28T00:00:00.000Z";
  const goal = fieldGoal([{ id: "f1", type: "finding", peerId: "r1", lane: "research", at, summary: "x" }]);
  const recent = derivePeerGoalSignalField(goal, { nowMs: Date.parse("2026-05-28T00:05:00.000Z") });
  const old = derivePeerGoalSignalField(goal, { nowMs: Date.parse("2026-05-28T03:00:00.000Z") });
  assert.ok(recent.lanes.research.attract > old.lanes.research.attract, "older deposit decayed");
});

test("signal field skips deposits with unparseable anchor timestamps", () => {
  const field = derivePeerGoalSignalField(
    fieldGoal([{ id: "f1", type: "finding", peerId: "r1", lane: "research", at: "not-a-date", summary: "x" }]),
    { nowMs: Date.parse("2026-05-28T01:00:00.000Z") },
  );
  assert.equal(Object.keys(field.lanes).length, 0, "no lane recorded for unparseable anchor");
});

test("signal field is empty and non-throwing for a goal with no events", () => {
  const field = derivePeerGoalSignalField(fieldGoal([]), { nowMs: Date.parse("2026-05-28T01:00:00.000Z") });
  assert.deepEqual(field.lanes, {});
  assert.equal(field.dominant, null);
  assert.deepEqual(field.channels, { attract: 0, repel: 0, frustration: 0 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/peer-goal-board.test.mjs`
Expected: FAIL — `derivePeerGoalSignalField is not a function` / `formatPeerGoalSignalField is not exported`.

- [ ] **Step 3: Implement `derivePeerGoalSignalField` and its deposit helpers**

Add the exported function right after `deriveGoalState` closes (after line 311):

```js
export function derivePeerGoalSignalField(goal, options = {}) {
  const state = goal && Array.isArray(goal.activeClaims) && Array.isArray(goal.staleClaims)
    ? goal
    : deriveGoalState(goal, options);
  const config = resolveSignalFieldConfig(options.signalField);
  const nowMs = Number.isFinite(options.nowMs)
    ? options.nowMs
    : Number.isFinite(Date.parse(options.now)) ? Date.parse(options.now) : Date.now();
  const lanes = new Map();
  const paths = new Map();

  const deposit = (channel, weight, anchorAt, lane, depositPaths) => {
    if (!(weight > 0)) return;
    const anchorMs = Date.parse(anchorAt || "");
    if (!Number.isFinite(anchorMs)) return; // skip unparseable anchors (spec edge case)
    const ageMs = Math.max(0, nowMs - anchorMs);
    const value = weight * Math.pow(0.5, ageMs / config.halfLifeMs);
    if (!(value > 0)) return;
    const laneKey = normalizeLaneName(lane) || "general";
    addSignalChannel(lanes, laneKey, channel, value, { isLane: true });
    for (const path of Array.isArray(depositPaths) ? depositPaths : []) {
      if (!path) continue;
      addSignalChannel(paths, path, channel, value, { isLane: false, lane: laneKey });
    }
  };

  const events = Array.isArray(state.events) ? state.events : [];
  for (const event of events) {
    if (event.type === "finding") deposit("attract", config.typeWeights.finding, event.at, event.lane, event.paths);
    else if (event.type === "resolve") deposit("attract", config.typeWeights.resolve, event.at, event.lane, event.paths);
  }
  for (const vote of state.passingVotes || []) deposit("attract", config.typeWeights.vote, vote.at, vote.lane, vote.paths);
  for (const task of state.tasks || []) {
    if (task.completedAt && SUCCESSFUL_TASK_HANDOFF_STATUSES.has(String(task.status || "").toLowerCase())) {
      deposit("attract", config.typeWeights.taskComplete, task.completedAt, task.lane, task.paths);
    }
  }

  for (const claim of state.activeClaims || []) {
    const weight = claim.mode === "write" ? config.typeWeights.claimWrite : config.typeWeights.claimRead;
    deposit("repel", weight, claim.lastHeartbeatAt || claim.at, claim.lane, claim.paths);
  }
  for (const task of state.activeTasks || []) deposit("repel", config.typeWeights.activeTask, task.at, task.lane, task.paths);

  for (const claim of state.staleClaims || []) deposit("frustration", config.typeWeights.staleClaim, claim.lastHeartbeatAt || claim.at, claim.lane, claim.paths);
  for (const claim of state.expiredClaims || []) deposit("frustration", config.typeWeights.expiredClaim, claim.expiresAt || claim.at, claim.lane, claim.paths);
  for (const vote of state.failedVotes || []) deposit("frustration", config.typeWeights.failedVote, vote.at, vote.lane, vote.paths);
  for (const objection of state.blockingObjections || []) deposit("frustration", config.typeWeights.blockingObjection, objection.at, objection.lane, objection.paths);
  for (const handoff of state.unresolvedTaskHandoffs || []) deposit("frustration", config.typeWeights.handoff, handoff.completedAt || handoff.at, handoff.lane, handoff.paths);

  return finalizeSignalField(state.id, nowMs, config, lanes, paths);
}
```

Add the deposit/finalize helpers near `roundSignal` (added in Task 1):

```js
function addSignalChannel(map, key, channel, value, { isLane, lane } = {}) {
  const entry = map.get(key) || (isLane
    ? { attract: 0, repel: 0, frustration: 0, deposits: 0 }
    : { lane, attract: 0, repel: 0, frustration: 0 });
  entry[channel] += value;
  if (isLane) entry.deposits += 1;
  else if (lane) entry.lane = lane;
  map.set(key, entry);
}

function finalizeSignalField(goalId, nowMs, config, lanes, paths) {
  const channels = { attract: 0, repel: 0, frustration: 0 };
  const laneObj = {};
  for (const [key, e] of lanes) {
    channels.attract += e.attract;
    channels.repel += e.repel;
    channels.frustration += e.frustration;
    laneObj[key] = {
      attract: roundSignal(e.attract),
      repel: roundSignal(e.repel),
      frustration: roundSignal(e.frustration),
      net: roundSignal(e.attract + e.frustration - e.repel),
      deposits: e.deposits,
    };
  }
  const pathObj = {};
  for (const [key, e] of paths) {
    pathObj[key] = {
      lane: e.lane,
      attract: roundSignal(e.attract),
      repel: roundSignal(e.repel),
      frustration: roundSignal(e.frustration),
      net: roundSignal(e.attract + e.frustration - e.repel),
    };
  }
  return {
    goalId,
    now: new Date(nowMs).toISOString(),
    halfLifeMs: config.halfLifeMs,
    lanes: laneObj,
    paths: pathObj,
    channels: {
      attract: roundSignal(channels.attract),
      repel: roundSignal(channels.repel),
      frustration: roundSignal(channels.frustration),
    },
    dominant: deriveDominantSignal(laneObj),
  };
}

function deriveDominantSignal(laneObj) {
  let best = null;
  let bestValue = 0;
  for (const [lane, e] of Object.entries(laneObj)) {
    for (const channel of ["attract", "repel", "frustration"]) {
      if (e[channel] > bestValue) {
        bestValue = e[channel];
        best = { lane, channel };
      }
    }
  }
  return best;
}
```

- [ ] **Step 4: Add a placeholder export so the import resolves**

`formatPeerGoalSignalField` is imported by the test (Task 3 implements it). To keep Task 2's run green for the field-derivation tests, temporarily add a minimal stub right after `derivePeerGoalSignalField`:

```js
export function formatPeerGoalSignalField(field = {}) {
  return `# Signal field ${field.goalId || ""}`.trim();
}
```

(Task 3 replaces the body.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/peer-goal-board.test.mjs`
Expected: PASS for the six new field-derivation tests; the whole file still passes.

- [ ] **Step 6: Commit**

```bash
git add src/peers/goal-board.mjs test/peer-goal-board.test.mjs
git commit -m "feat(goal-board): derive stigmergic signal field from event stream"
```

---

## Task 3: `formatPeerGoalSignalField` view

**Files:**
- Modify: `src/peers/goal-board.mjs` (replace the stub from Task 2)
- Test: `test/peer-goal-board.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test("formatPeerGoalSignalField renders lanes, dominant, and hot paths", () => {
  const nowMs = Date.parse("2026-05-28T00:10:00.000Z");
  const text = formatPeerGoalSignalField(
    derivePeerGoalSignalField(
      fieldGoal([
        { id: "c1", type: "claim", peerId: "w1", mode: "write", lane: "implementation", paths: ["src/a.mjs"], at: "2026-05-28T00:00:00.000Z", summary: "edit" },
        { id: "f1", type: "finding", peerId: "r1", lane: "research", at: "2026-05-28T00:05:00.000Z", summary: "found" },
      ]),
      { nowMs },
    ),
  );
  assert.match(text, /# Signal field g1/);
  assert.match(text, /implementation:/);
  assert.match(text, /research:/);
  assert.match(text, /Crowded\/stuck paths:/);
  assert.match(text, /src\/a\.mjs/);
});

test("formatPeerGoalSignalField reports a quiet field", () => {
  const text = formatPeerGoalSignalField(derivePeerGoalSignalField(fieldGoal([]), { nowMs: Date.parse("2026-05-28T00:10:00.000Z") }));
  assert.match(text, /No live signal/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/peer-goal-board.test.mjs`
Expected: FAIL — stub output does not contain `implementation:` / `No live signal`.

- [ ] **Step 3: Replace the stub with the full implementation**

```js
export function formatPeerGoalSignalField(field = {}) {
  const lanes = field.lanes || {};
  const laneNames = Object.keys(lanes).sort((a, b) => Math.abs(lanes[b].net) - Math.abs(lanes[a].net));
  const channels = field.channels || { attract: 0, repel: 0, frustration: 0 };
  const lines = [
    `# Signal field ${field.goalId || ""}`.trim(),
    `half-life: ${Math.round((field.halfLifeMs || 0) / 60000)}m · attract ${channels.attract} · repel ${channels.repel} · frustration ${channels.frustration}`,
  ];
  if (!laneNames.length) {
    lines.push("", "No live signal. The field is quiet — no recent deposits remain after decay.");
    return lines.join("\n");
  }
  if (field.dominant) lines.push(`dominant: ${field.dominant.lane} (${field.dominant.channel})`);
  lines.push("", "Lanes (↑attract / ↓repel / ⚠frustration · net):");
  for (const lane of laneNames) {
    const e = lanes[lane];
    lines.push(`- ${lane}: ↑${e.attract} ↓${e.repel} ⚠${e.frustration} · net ${e.net} · ${e.deposits} deposit${e.deposits === 1 ? "" : "s"}`);
  }
  const hotPaths = Object.entries(field.paths || {})
    .filter(([, e]) => e.frustration > 0 || e.repel > 0)
    .sort((a, b) => (b[1].repel + b[1].frustration) - (a[1].repel + a[1].frustration))
    .slice(0, 5);
  if (hotPaths.length) {
    lines.push("", "Crowded/stuck paths:");
    for (const [path, e] of hotPaths) lines.push(`- ${path} (${e.lane}): ↓${e.repel} ⚠${e.frustration}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/peer-goal-board.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/peers/goal-board.mjs test/peer-goal-board.test.mjs
git commit -m "feat(goal-board): add signal-field text view"
```

---

## Task 4: Fold the field into scout pressure (`scoutFieldAdjust` + `annotateScoutPressure`)

**Files:**
- Modify: `src/peers/goal-board.mjs` (`derivePeerGoalScoutSuggestions` ~line 360, `annotateScoutPressure` ~line 1384, add `scoutFieldAdjust` helper)
- Test: `test/peer-goal-board.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test("scout pressure demotes a crowded write lane and promotes a frustrated one", () => {
  const nowMs = Date.parse("2026-05-28T00:10:00.000Z");
  // Build a board with one goal whose implementation lane is crowded (active write claim)
  // and verify the implementation next-step suggestion carries negative fieldAdjust.
  const board = {
    goals: {
      g1: {
        id: "g1",
        objective: "x",
        status: "open",
        createdAt: "2026-05-28T00:00:00.000Z",
        updatedAt: "2026-05-28T00:05:00.000Z",
        events: [
          { id: "c1", type: "claim", peerId: "w1", mode: "write", lane: "implementation", paths: ["src/a.mjs"], at: "2026-05-28T00:05:00.000Z", summary: "edit" },
        ],
      },
    },
  };
  const suggestions = derivePeerGoalScoutSuggestions(board, { nowMs });
  const impl = suggestions.find((s) => s.recommendedLane === "implementation");
  assert.ok(impl, "implementation suggestion exists");
  assert.ok((impl.fieldAdjust || 0) < 0, "crowded write lane is demoted");
  assert.ok(impl.pressureReasons.includes("field-repel"));
});

test("scout pressure leaves read/review lanes largely undemoted by repellent (damping)", () => {
  const nowMs = Date.parse("2026-05-28T00:10:00.000Z");
  const board = {
    goals: {
      g1: {
        id: "g1", objective: "x", status: "open",
        createdAt: "2026-05-28T00:00:00.000Z", updatedAt: "2026-05-28T00:05:00.000Z",
        events: [
          { id: "c1", type: "claim", peerId: "w1", mode: "read", lane: "review", at: "2026-05-28T00:05:00.000Z", summary: "review" },
        ],
      },
    },
  };
  const suggestions = derivePeerGoalScoutSuggestions(board, { nowMs });
  const review = suggestions.find((s) => s.recommendedLane === "review");
  // damped read repellent must not drive a large negative adjust
  if (review) assert.ok((review.fieldAdjust || 0) > -3, "review lane only lightly affected");
});

test("scout field adjust is disabled when signalField.enabled is false", () => {
  const nowMs = Date.parse("2026-05-28T00:10:00.000Z");
  const board = {
    goals: {
      g1: {
        id: "g1", objective: "x", status: "open",
        createdAt: "2026-05-28T00:00:00.000Z", updatedAt: "2026-05-28T00:05:00.000Z",
        events: [{ id: "c1", type: "claim", peerId: "w1", mode: "write", lane: "implementation", at: "2026-05-28T00:05:00.000Z", summary: "edit" }],
      },
    },
  };
  const suggestions = derivePeerGoalScoutSuggestions(board, { nowMs, signalField: { enabled: false } });
  for (const s of suggestions) assert.equal(s.fieldAdjust, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/peer-goal-board.test.mjs`
Expected: FAIL — suggestions have no `fieldAdjust` / `field-repel` reason yet.

- [ ] **Step 3: Add `scoutFieldAdjust`**

Add near `annotateScoutPressure` (after it, ~line 1399):

```js
function scoutFieldAdjust(suggestion = {}, field, config) {
  const empty = { adjust: 0, signal: { attract: 0, repel: 0, frustration: 0, net: 0 }, reasons: [] };
  if (!field || config.enabled === false) return empty;
  if (cleanText(suggestion.priority || "P2").toUpperCase() === "P0") return empty;
  const lane = normalizeLaneName(suggestion.recommendedLane) || "general";
  const laneSig = field.lanes?.[lane] || { attract: 0, repel: 0, frustration: 0 };
  let attract = laneSig.attract;
  let repel = laneSig.repel;
  let frustration = laneSig.frustration;
  for (const path of Array.isArray(suggestion.paths) ? suggestion.paths : []) {
    const ps = field.paths?.[path];
    if (!ps) continue;
    attract = Math.max(attract, ps.attract);
    repel = Math.max(repel, ps.repel);
    frustration = Math.max(frustration, ps.frustration);
  }
  const isWrite = suggestion.claimMode === "write" || lane === "implementation";
  const repelEffective = repel * (isWrite ? 1 : config.repelReadDamping);
  const raw = config.weights.attract * attract + config.weights.frustration * frustration - config.weights.repel * repelEffective;
  const adjust = Math.max(-config.maxAdjust, Math.min(config.maxAdjust, Math.round(raw)));
  const reasons = [];
  if (attract > 0) reasons.push("field-attract");
  if (repelEffective > 0) reasons.push("field-repel");
  if (frustration > 0) reasons.push("field-frustration");
  return {
    adjust,
    signal: { attract: roundSignal(attract), repel: roundSignal(repel), frustration: roundSignal(frustration), net: roundSignal(attract + frustration - repel) },
    reasons,
  };
}
```

- [ ] **Step 4: Wire the field into `annotateScoutPressure`**

Replace the body of `annotateScoutPressure` (lines 1384-1399) with:

```js
function annotateScoutPressure(suggestion = {}, state = {}, goal = {}, options = {}) {
  const priority = cleanText(suggestion.priority || "P2").toUpperCase();
  const base = scoutPressureBaseScore(suggestion, state);
  const ageMs = scoutPressureAgeMs(suggestion, state, goal, options.nowMs);
  const decay = scoutPressureDecay(suggestion, priority, ageMs);
  const fieldConfig = resolveSignalFieldConfig(options.signalField);
  const fieldResult = scoutFieldAdjust(suggestion, options.field, fieldConfig);
  const score = Math.max(SCOUT_PRESSURE_FLOORS[priority] ?? SCOUT_PRESSURE_FLOORS.P2, base - decay + fieldResult.adjust);
  return stripEmpty({
    ...suggestion,
    pressureScore: score,
    pressureBase: base,
    pressureDecay: decay,
    pressureAgeMinutes: Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 60_000)) : undefined,
    pressureReasons: [...scoutPressureReasons(suggestion, state, decay), ...fieldResult.reasons],
    fieldAdjust: fieldResult.adjust || undefined,
    fieldSignal: fieldResult.adjust ? fieldResult.signal : undefined,
    scoutSequence: options.sequence,
  });
}
```

- [ ] **Step 5: Compute the field once per goal in `derivePeerGoalScoutSuggestions` and pass it through**

In `derivePeerGoalScoutSuggestions`, locate (line 360-364):

```js
    const state = deriveGoalState(goal, { now: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : undefined });
    const push = (priority, kind, summary, extra = {}) => {
      const suggestion = annotateScoutPressure(enrichScoutSuggestion({ goalId: goal.id, priority, kind, summary, ...extra }), state, goal, { nowMs, sequence: sequence++ });
      if (!hasActiveWorkForScoutSuggestion(state, suggestion)) suggestions.push(suggestion);
    };
```

Replace with:

```js
    const state = deriveGoalState(goal, { now: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : undefined });
    const field = derivePeerGoalSignalField(state, { nowMs, signalField: options.signalField });
    const push = (priority, kind, summary, extra = {}) => {
      const suggestion = annotateScoutPressure(enrichScoutSuggestion({ goalId: goal.id, priority, kind, summary, ...extra }), state, goal, { nowMs, sequence: sequence++, field, signalField: options.signalField });
      if (!hasActiveWorkForScoutSuggestion(state, suggestion)) suggestions.push(suggestion);
    };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/peer-goal-board.test.mjs`
Expected: PASS, including all pre-existing scout tests (the field only adjusts P1/P2 scores and never reorders priority tiers).

- [ ] **Step 7: Commit**

```bash
git add src/peers/goal-board.mjs test/peer-goal-board.test.mjs
git commit -m "feat(goal-board): bias scout pressure with the signal field"
```

---

## Task 5: `/peer goal field <id>` command (parse + execute)

**Files:**
- Modify: `src/peers/command.mjs` (alias map ~line 12, parse switch ~line 634)
- Modify: `extensions/pi-peer/index.ts` (import ~line 16, execution ~line 1411, completions ~line 140)
- Test: `test/peer-goal-board.test.mjs`

- [ ] **Step 1: Write the failing parse test**

Add to `test/peer-goal-board.test.mjs` (the file already imports `parsePeerCommand`):

```js
test("/peer goal field parses to a field goal action", () => {
  const parsed = parsePeerCommand("goal field g1");
  assert.equal(parsed.goalAction, "field");
  assert.equal(parsed.goalId, "g1");
});

test("/peer field alias parses to a field goal action", () => {
  const parsed = parsePeerCommand("field g1");
  assert.equal(parsed.goalAction, "field");
  assert.equal(parsed.goalId, "g1");
});
```

Note: confirm `parsePeerCommand`'s argument convention by glancing at an existing parse test in this file; if it takes a pre-split array or a leading `/peer`, match that exact form. (Existing tests in the file are the source of truth for the call signature.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/peer-goal-board.test.mjs`
Expected: FAIL — `goalAction` is not `"field"` (currently falls through to the unknown-action error).

- [ ] **Step 3: Add the alias and parse case**

In `src/peers/command.mjs`, add to `PEER_GOAL_ALIASES` (after line 12 `scout: ["scout"],`):

```js
  field: ["field"],
```

Add the parse case after line 634 (`if (action === "scout") ...`):

```js
  if (action === "field") return { ...withAction, goalId: rest[0], includeClosed: flagEnabled(flags.includeClosed) };
```

- [ ] **Step 4: Run the parse test to verify it passes**

Run: `node --test test/peer-goal-board.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire execution in the extension**

In `extensions/pi-peer/index.ts`, extend the goal-board import on line 16 to include `derivePeerGoalSignalField` and `formatPeerGoalSignalField`:

```ts
import { appendPeerGoalEvent, closePeerGoal, createPeerGoal, deriveGoalState, derivePeerGoalScoutSuggestions, derivePeerGoalSignalField, formatPeerGoal, formatPeerGoalList, formatPeerGoalPlanVerification, formatPeerGoalScout, formatPeerGoalSignalField, formatPeerGoalSynthesis, loadPeerGoalBoard } from "../../src/peers/goal-board.mjs";
```

Add the execution branch immediately after line 1411 (`if (parsed.goalAction === "scout") ...`):

```ts
  if (parsed.goalAction === "field") {
    const board = await loadPeerGoalBoard(root);
    const goalId = parsed.goalId || board.currentGoalId;
    const goal = goalId ? board.goals[goalId] : undefined;
    if (!goal) throw new Error(goalId ? `peer goal ${goalId} not found` : "no current peer goal");
    return formatPeerGoalSignalField(derivePeerGoalSignalField(goal));
  }
```

Add `"field"` to the `getArgumentCompletions` array on line 140 (insert after `"scout"`):

```ts
    getArgumentCompletions: (prefix: string) => ["help", "status", "list", "center", "work", "init", "setup", "do", "mission", "accomplish", "subrun", "spawn", "org", "doctor", "reconnect", "resume", "cancel", "send", "get", "await", "progress", "goal", "hive", "swarm", "self-improve", "improve", "factory", "metrics", "goals", "ls", "current", "scout", "field", "dashboard", "fanout", "proposal", "propose", "claim", "take", "done", "complete", "block", "objection", "unblock", "pass", "fail"]
```

- [ ] **Step 6: Run the full goal-board suite and the pack check**

Run: `node --test test/peer-goal-board.test.mjs && npm run check:pack`
Expected: tests PASS; pack dry-run succeeds (the extension `.ts` is shipped, so it must stay syntactically valid).

- [ ] **Step 7: Commit**

```bash
git add src/peers/command.mjs extensions/pi-peer/index.ts test/peer-goal-board.test.mjs
git commit -m "feat(peer): add /peer goal field signal-field view command"
```

---

## Task 6: Emergent field metrics

**Files:**
- Modify: `src/peers/metrics.mjs` (add import, `derivePeerSignalFieldMetrics`, fold into `derivePeerFactoryMetrics` + `formatPeerFactoryMetrics`)
- Test: `test/peer-metrics.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `test/peer-metrics.test.mjs` (match the file's existing import style; add `derivePeerSignalFieldMetrics` to the `metrics.mjs` import):

```js
test("derivePeerSignalFieldMetrics summarizes dispersion, focus, and frustration", () => {
  const nowMs = Date.parse("2026-05-28T00:10:00.000Z");
  const goals = [
    {
      id: "g1", status: "open",
      createdAt: "2026-05-28T00:00:00.000Z", updatedAt: "2026-05-28T00:05:00.000Z",
      events: [
        { id: "c1", type: "claim", peerId: "w1", mode: "write", lane: "implementation", at: "2026-05-28T00:05:00.000Z", summary: "edit" },
        { id: "f1", type: "finding", peerId: "r1", lane: "research", at: "2026-05-28T00:05:00.000Z", summary: "found" },
      ],
    },
    { id: "g2", status: "closed", events: [] },
  ];
  const metrics = derivePeerSignalFieldMetrics(goals, { nowMs });
  assert.equal(metrics.dispersion, 1, "one lane carries live repellent");
  assert.equal(metrics.focusLane, "research");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/peer-metrics.test.mjs`
Expected: FAIL — `derivePeerSignalFieldMetrics is not a function`.

- [ ] **Step 3: Implement the metric**

At the top of `src/peers/metrics.mjs`, add the import (above the existing constants):

```js
import { derivePeerGoalSignalField } from "./goal-board.mjs";
```

Add the exported function (near `derivePeerFactoryMetrics`):

```js
export function derivePeerSignalFieldMetrics(goals = [], options = {}) {
  const laneTotals = new Map();
  const repellentLanes = new Set();
  for (const goal of array(goals)) {
    if (goal?.status === "closed") continue;
    const field = derivePeerGoalSignalField(goal, options);
    for (const [lane, e] of Object.entries(field.lanes || {})) {
      const total = laneTotals.get(lane) || { attract: 0, repel: 0, frustration: 0 };
      total.attract += e.attract;
      total.repel += e.repel;
      total.frustration += e.frustration;
      laneTotals.set(lane, total);
      if (e.repel > 0) repellentLanes.add(lane);
    }
  }
  let focusLane;
  let focusValue = 0;
  let frustrationLane;
  let frustrationValue = 0;
  for (const [lane, total] of laneTotals) {
    if (total.attract > focusValue) { focusValue = total.attract; focusLane = lane; }
    if (total.frustration > frustrationValue) { frustrationValue = total.frustration; frustrationLane = lane; }
  }
  return { dispersion: repellentLanes.size, focusLane, hottestFrustrationLane: frustrationLane };
}
```

- [ ] **Step 4: Fold it into the factory metrics**

In `derivePeerFactoryMetrics`, after `const goals = array(input.goals);` add:

```js
  const signalField = derivePeerSignalFieldMetrics(goals, { nowMs: input.nowMs });
```

In the object returned by `derivePeerFactoryMetrics`, add these three properties (before the closing `};` of the `return {`):

```js
    signalDispersion: signalField.dispersion,
    signalFocusLane: signalField.focusLane,
    signalFrustrationLane: signalField.hottestFrustrationLane,
```

In `formatPeerFactoryMetrics`, add a line to the returned array (after the `idle useful:` line):

```js
    `signal field — dispersion: ${integer(metrics.signalDispersion)} lanes | focus: ${metrics.signalFocusLane || "—"} | hottest frustration: ${metrics.signalFrustrationLane || "—"}`,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/peer-metrics.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/peers/metrics.mjs test/peer-metrics.test.mjs
git commit -m "feat(metrics): add emergent signal-field metrics"
```

---

## Task 7: Documentation and full verification

**Files:**
- Modify: `README.md`
- Test: full suite

- [ ] **Step 1: Add a README bullet**

Under the "What it adds" / emergent-coordination bullets in `README.md`, add:

```markdown
- Stigmergic signal field: a decay-weighted read-model derived from each goal's events (attractant from findings/passing votes/completed tasks, repellent from live claims, frustration from stale/abandoned work) that biases scout routing toward complementary work and away from dogpiles. Inspect it with `/peer goal field <goal-id>`.
```

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`
Expected: all `test/peer-*.test.mjs` files PASS.

- [ ] **Step 3: Run the pack check**

Run: `npm run check:pack`
Expected: dry-run pack succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the stigmergic signal field"
```

---

## Self-Review Notes

**Spec coverage:**
- Three channels + shared decay → Task 2. ✓
- Lane + path keying → Task 2 (`paths` map) + Task 4 (path-max in `scoutFieldAdjust`). ✓
- Frustration inverts decay (touch-and-abandon surfaces) → Task 2 frustration deposits anchored at recent touch timestamps; multiple abandonment events accumulate as separate decayed deposits (realizes the spec's `cycleScale` intent additively rather than as a multiplier — same emergent effect, simpler). ✓
- Repellent damped for read/review lanes → Task 4 `repelReadDamping`. ✓
- P0 immune to field → Task 4 `scoutFieldAdjust` early return. ✓
- `field disabled` ⇒ identical baseline → Task 4 test. ✓
- `/peer goal field` view → Task 3 + Task 5. ✓
- Emergent metrics (dispersion / focus / hottest frustration) → Task 6. ✓
- Unparseable-timestamp deposits skipped; empty goal → empty field → Task 2 tests. ✓
- Determinism via injected `nowMs` → every task injects `nowMs`. ✓

**Placeholder scan:** No TBD/TODO. Task 1 Step 3 intentionally defers its test to Task 2 (private helpers are exercised through the public function) — this is a real decision, not a gap. Task 5 Step 1 flags that the exact `parsePeerCommand` call signature must match existing tests in the file; the implementer confirms against neighbours rather than guessing.

**Type consistency:** `derivePeerGoalSignalField` / `formatPeerGoalSignalField` / `scoutFieldAdjust` / `derivePeerSignalFieldMetrics` names are used identically across tasks. Field object shape (`lanes`, `paths`, `channels`, `dominant`, `now`, `halfLifeMs`, `goalId`) is defined once in Task 2 and consumed unchanged in Tasks 3, 4, 6. Channel keys (`attract`/`repel`/`frustration`) and suggestion fields (`fieldAdjust`/`fieldSignal`/`pressureReasons`) are consistent throughout.
```
