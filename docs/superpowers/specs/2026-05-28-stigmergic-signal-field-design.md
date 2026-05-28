# Stigmergic Signal Field — Design

Date: 2026-05-28
Status: Approved for planning
Topic: Emergent coordination via a decay-weighted signal field derived from the goal-board event stream

## Problem

Peers coordinate today through explicit board events (claims, proposals, findings, votes, objections) and a scout layer that turns board state into prioritized, work-keyed suggestions. The scout's `pressureScore` is a one-directional staleness timer: a suggestion starts at a base score by `kind` and only loses pressure as its source event ages (`annotateScoutPressure` → `scoutPressureDecay`).

This produces no *emergent* steering. There is no mechanism by which the **collective recent activity** of peers reshapes where the next idle peer goes:

- Newly-idle peers can pile onto a lane/path that is already crowded (the file-collision problem the package exists to solve is only prevented *after* a write claim conflicts, not *before* peers route there).
- Lanes where progress is actively happening do not pull complementary review/research eyes toward them.
- Work that is repeatedly picked up and dropped (touch-and-abandon) *sinks* under temporal decay instead of surfacing — the opposite of what we want.

## Goal

Add a **stigmergic signal field**: a pure, deterministic read-model computed from each goal's existing event stream. Peer actions act as deposits; deposits decay over a shared half-life substrate; the aggregated field biases scout routing so coordination emerges from local traces with no central assigner, no new event type, and no new writes.

Non-goals (explicitly deferred):
- Explicit `signal` deposit events / a deposit command (we derive from existing events only).
- Idle-watcher activation *gating* on the field (routing via pressure ordering is sufficient for v1; gating can come later).
- Config-file (`config.mjs`) exposure of weights (v1 uses module constants with an `options` override, mirroring the existing `SCOUT_PRESSURE_*` constants).

## Concept: one field, three channels, one decay substrate

For a goal, the field carries three signal channels keyed by **lane** (always) and **path** (when events carry paths):

| Channel | Deposited by (existing events) | Emergent effect |
| --- | --- | --- |
| **Attractant** | findings, passing votes (`pass` / `pass-with-risks`), completed/verified tasks, resolutions | Pulls complementary read/review peers toward where progress is happening |
| **Repellent** | live concentration: active claims (write heavier than read), active tasks/dispatches | Pushes newly-idle peers off crowded write work → anti-dogpile |
| **Frustration** | touch-and-abandon: released-without-completion claims, stale/expired claims, unresolved blocking objections, failed votes, unresolved handoffs | Stuck-but-churned work *heats up* and surfaces itself — inverts decay |

### Deposit & decay model

Each qualifying event contributes to one channel at one or more `(lane, path?)` keys:

```
contribution = typeWeight × cycleScale × 0.5 ^ (ageMs / halfLifeMs)
```

- `ageMs = now − anchorTime`, where `anchorTime` is the event's own `at` (for frustration, the most recent touch timestamp of the abandoned thing — e.g. a stale claim anchors at its last heartbeat / computed stale-transition time).
- `cycleScale = 1 + abandonCycles` for frustration deposits (a lane picked up and dropped N times deposits proportionally more), `1` otherwise.
- `halfLifeMs` defaults to 45 minutes; injectable for tests.

Because each abandonment is a fresh deposit anchored at its own recent timestamp, frustration **rises** as churn continues and **cools** only when the work is genuinely left alone — the desired inversion, achieved without age-proportional hacks.

Per `(lane)` and `(lane, path)` we sum each channel, plus a goal-level rollup:

```js
derivePeerGoalSignalField(goal, options) → {
  goalId, now, halfLifeMs,
  lanes:    { [lane]: { attract, repel, frustration, net, deposits } },
  paths:    { [path]: { lane, attract, repel, frustration, net } },
  channels: { attract, repel, frustration },        // goal rollup
  dominant: { lane, channel } | null,
}
```

`net = attract + frustration − repel`. All numbers are decayed sums (floats, rounded for display).

### Channel → routing modulation

`annotateScoutPressure` gains a field term layered on the existing `base − decay`:

```
fieldAdjust = clamp(
  round( w_a·attract(key) + w_f·frustration(key) − w_r·repelEffective(key) ),
  -MAX_ADJUST, +MAX_ADJUST
)
score = max(priorityFloor, base − decay + fieldAdjust)
```

Repellent is *modulated by claim mode*: it applies in full to write/implementation suggestions but is damped (`× repelReadDamping`, default 0.25) for read/review lanes — redundant review eyes *help* closure policy, so we don't repel them. P0 suggestions ignore `fieldAdjust` entirely (blockers must not be down-weighted by field noise), matching how P0 already ignores decay.

The `key` used is the suggestion's most specific available: `(lane, path)` if the suggestion names a path, else `(lane)`.

Each suggestion gains:
- `fieldSignal: { attract, repel, frustration, net }`
- `fieldAdjust` (the applied delta)
- new `pressureReasons` entries: `field-attract`, `field-repel`, `field-frustration` (only those that materially contributed).

`compareScoutSuggestions` is unchanged — it already sorts by priority then `pressureScore`; the field flows through the score. The **idle-watcher inherits this for free** because it routes off `derivePeerGoalScoutSuggestions`.

## Components

All changes are additive and live alongside existing patterns.

### 1. `src/peers/goal-board.mjs` (core)
- `SIGNAL_FIELD` module constants: `halfLifeMs`, channel `weights`, `maxAdjust`, `repelReadDamping`, per-event-type `typeWeights` (mirrors the `SCOUT_PRESSURE_*` constant convention).
- `derivePeerGoalSignalField(goal, options)` — pure; `options.now`/`options.nowMs` and `options.signalField` (override constants) for testability.
- `formatPeerGoalSignalField(field)` — human view (per-lane bars: attract ↑ / repel ↓ / frustration ⚠, dominant lane, top frustrated paths).
- `annotateScoutPressure` — accept the field (computed once per goal in `derivePeerGoalScoutSuggestions`, like `state`) and apply `fieldAdjust` + reasons + `fieldSignal`.
- Helper `scoutFieldAdjust(suggestion, field)` keeps the modulation (mode damping, P0 skip, key selection) isolated and unit-testable.

### 2. `src/peers/command.mjs` (surface)
- Parse `/peer goal field <goal-id>` in the goal action switch (alongside `scout`, ~line 634): `{ action: "field", goalId: rest[0] }`.
- Add to `command-help.mjs` goal subcommand list.

### 3. Command execution (`command-center.mjs` / extension goal handler)
- Wire `field` action → load board, `deriveGoalState` is not required; call `derivePeerGoalSignalField(goal)` and print `formatPeerGoalSignalField`. (Read-only, like `scout`.)

### 4. `src/peers/metrics.mjs` (emergent observability — small)
- `derivePeerSignalFieldMetrics(goals, options)` → `{ dispersion, focusLane, hottestFrustrationLane }`:
  - `dispersion` = count of distinct lanes carrying live repellent across open goals (are peers spread or clustered).
  - `focusLane` = lane with the highest summed attractant (where the swarm is converging).
  - `hottestFrustrationLane` = lane with the highest frustration (what is stuck).
- Append one summary line to `formatPeerFactoryMetrics`.

## Data flow

```
goal.events ──► derivePeerGoalSignalField (decay-weighted deposits, pure)
                   │
                   ├──► formatPeerGoalSignalField ──► /peer goal field <id>  (observability)
                   │
                   └──► annotateScoutPressure (per-suggestion fieldAdjust)
                            │
                            ├──► /peer goal scout  (ordering + fieldSignal display)
                            └──► idle-watcher       (inherits via scout suggestions)

open goals ──► derivePeerSignalFieldMetrics ──► /peer metrics line
```

## Error handling & edge cases

- Missing/empty events → all channels `0`, `dominant: null`. Field never throws; mirrors `deriveGoalState` tolerance of partial goals.
- Unparseable timestamps → deposit treated as decay-neutral fresh (`age 0`) is wrong (would over-weight garbage), so: a deposit with an unparseable anchor is **skipped** (contributes 0). Documented and tested.
- Closed goals → excluded from scout/metrics exactly as today (`derivePeerGoalScoutSuggestions` already filters; `field` view may still render a closed goal on explicit request).
- Determinism → no `Date.now()` inside pure functions when `options.nowMs` is supplied; callers inject. (Production callers pass `Date.now()` at the boundary, as scout already does.)
- Backward compatibility → suggestions without field data (field disabled via `options.signalField.enabled = false`) behave exactly as today; `fieldAdjust` defaults to 0.

## Testing (TDD, `test/peer-goal-board.test.mjs` + `test/peer-metrics.test.mjs`)

Field derivation:
- write claim → repellent on its lane/paths; read claim → smaller repellent.
- finding / passing vote / completed task → attractant.
- stale claim / released-incomplete / failed vote / unresolved handoff → frustration.
- decay: an older deposit contributes strictly less than an identical recent one (inject two `nowMs`).
- frustration cycle scaling: two abandon cycles on a lane > one.
- unparseable anchor timestamp → skipped (0 contribution).

Routing integration:
- crowded write lane suggestion ranks **below** an equivalent uncrowded one.
- frustrated lane suggestion ranks **above** a fresh untouched one of the same kind.
- repel damping: a review/read suggestion on a crowded lane is *not* materially demoted.
- P0 suggestion score is unaffected by field.
- `field disabled` → identical ordering and scores to pre-change baseline.

Surface:
- `formatPeerGoalSignalField` output shape (lanes, dominant, bars).
- `/peer goal field <id>` parses to `{ action: "field", goalId }`; missing id → error string.
- `derivePeerSignalFieldMetrics` rollups; metrics line renders.

## Rollout

Single PR. Additive, behind the implicit `signalField.enabled` (default true) constant so it can be flipped off without code surgery if routing needs tuning. Version bump handled by the ship flow.
