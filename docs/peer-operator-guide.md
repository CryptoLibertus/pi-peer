# Peer operator guide

Use this guide when you are an agent operating `@cryptolibertus/pi-peer` after setup. `README.md` is the full reference; this file is the fast checklist for live work.

## Start or resume

1. Run `/peer center` to inspect local identity, active peers, goals, tasks, blockers, and recommended next commands.
2. Run `/peer reconnect` after starting or restarting managed/terminal peer sessions, then `/peer list` to verify active peers.
3. For multi-part work, create or reuse a goal and use `/peer scout <goal-id>` before claiming or dispatching lanes.

## Mission workflow

For substantial work, prefer the mission facade:

```bash
/peer do "Ship a verified improvement to peer coordination" --path src/peers --gate test --gate pack
```

The mission facade creates or reuses a goal, seeds peer lanes, links a factory run, and prints the remaining evidence commands. It records coordination state only; it does not run tests, publish packages, create PRs, or perform remote writes by itself.

## Fan-out and claims

- Run `/peer list` or use `peer_list` before choosing peers.
- Delegate read/review/research lanes with stable work keys and no write paths.
- Claim implementation writes only after naming exact `--path` values.
- Use worktree isolation for write-heavy peer lanes when available.
- Do not duplicate active claims or work keys unless an explicit independent second opinion uses `--duplicate-policy allow-parallel`.

Example direct dispatch:

```bash
/peer send worker2 "Review docs for stale peer workflow instructions" --goal <goal-id> --key review:docs --no-await
```

## Factory verification

Run verification outside peer, then record evidence:

```bash
/peer factory plan-review <goal-id> --gate=test --gate=pack
npm test
npm run check:pack
/peer factory gate <run-id> test pass --evidence "npm test passed"
/peer factory gate <run-id> pack pass --evidence "npm run check:pack passed"
/peer factory metrics
```

If a gate fails, record the failed gate first and create a rework record instead of blindly retrying:

```bash
/peer factory gate <run-id> test fail --evidence "npm test failed: <summary>"
/peer factory rework <run-id>
```

Before closing substantial peer work, inspect `/peer factory status` and `/peer do metrics` output.

## Handoffs and closure

Final peer handoffs must include these headings:

- `Status`
- `Files changed`
- `Verification`
- `Blockers/risks`
- `Safe for review`

Normal goal closure requires no unresolved blockers or unsuccessful handoffs, no active/stale claims, no running tasks, all proposals resolved/deferred, at least one current passing vote, and no failed votes. For documentation/research lanes, include citations/sources, fact-checks, limitations, and confidence when useful.

## Documentation sources

- `README.md` — full user and operator reference.
- `AGENTS.md` — repo-local instructions future agents should follow first.
- `skills/pi-peer-publish/SKILL.md` — release workflow; it always leaves final `npm publish --access public` for the user.
- `docs/superpowers/**` — historical implementation plans/specs. Use them as design background only; prefer current source, tests, README, AGENTS, and this guide for live command behavior.
