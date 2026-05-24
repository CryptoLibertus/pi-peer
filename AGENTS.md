# pi-peer agent notes

## Verification-first factory

Use `/peer factory status` and `/peer do metrics` before closing substantial peer work. Failed gates should become `/peer factory rework <run-id>` records, not blind retries. Repeated failures should become `/peer context patch --trigger <trigger> --change <change> --metric <metric> --eval <eval-name> --owner <peer-id> --review-date YYYY-MM-DD` proposals followed by `/peer context eval <patch-id> <pass|fail> --eval <eval-name> --evidence <text>`.

Factory workflow quickstart:

```bash
/peer setup id smoke-verifier
/peer setup 6
/peer center
/peer do start goal "Smoke test factory verification"
/peer do plan <goal-id>
# run the printed /peer factory plan-review ... command
/peer do verify <goal-id>
# run the printed /peer factory run ... command and copy the run-id
/peer factory gate <run-id> test pass --evidence "npm test passed"
/peer factory gate <run-id> pack pass --evidence "npm pack --dry-run passed"
/peer factory metrics
/peer center
```

Expected result: the run is `verified`, metrics show one verified run, and `/peer center` stops recommending rework for that run. `/peer do` commands recommend or create peer/factory records; they do not automatically run shell verification or publish artifacts.

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
