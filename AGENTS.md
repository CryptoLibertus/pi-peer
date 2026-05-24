# pi-peer agent notes

## Verification-first factory

Use `/peer factory status` and `/peer do metrics` before closing substantial peer work. Failed gates should become `/peer factory rework` records, not blind retries. Repeated failures should become `/peer context patch` proposals with eval evidence.

## Bounded recursive self-improvement

Use `/peer self-improve` when a user wants this repo to improve the peer system through bounded, reviewable experiments.

Common flow:

```bash
/peer self-improve init
/peer self-improve status
/peer self-improve run "Improve peer coordination safety" --loops 10 --path src/peers --eval "npm test"
```

Use dispatch only when explicitly requested or when a bounded peer run is appropriate:

```bash
/peer self-improve run "Improve idle watcher usefulness" \
  --loops 10 \
  --duration 30m \
  --peer worker2,worker3 \
  --dispatch \
  --path src/peers \
  --eval "npm test"
```

What it creates:

- `.pi/self-improve/constitution.md` — user-editable philosophy, non-goals, and promotion rules
- `.pi/self-improve/goals.json` — high-level improvement targets
- `.pi/self-improve/experiments.jsonl` — append-only experiment/run ledger
- a normal peer goal with dependency-gated loop work-items and lane proposals

Safety expectations:

- Runs are bounded; `--loops` is capped at 100.
- Peer dispatch is off by default and requires `--dispatch` plus `--duration`; pass `--peer` to choose peers, or omit it to use active compatible peers.
- Write work still needs explicit paths and should use worktree/branch isolation.
- `--auto-commit` is policy metadata only; it does not automatically publish or bypass review gates.
- Never run `npm publish`, force-push, destructive filesystem/database commands, or weaken tests as part of autonomous self-improvement.
- Promotion requires passing evals, peer review evidence, no unresolved blockers/proposals, and a clear ledger/goal-board handoff.

Implementation references:

- Command parser: `src/peers/command.mjs`
- Runtime wiring: `extensions/pi-peer/index.ts`
- Self-improvement module: `src/peers/self-improve.mjs`
- Tests: `test/peer-self-improve.test.mjs`, `test/peer-command.test.mjs`
- User docs: `README.md` section “Bounded self-improvement runs”
