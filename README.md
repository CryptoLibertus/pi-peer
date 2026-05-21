# @cryptolibertus/pi-peer

Pi package for local Pi-to-Pi peer messaging.

## Install

```bash
pi install npm:@cryptolibertus/pi-peer
# or while developing from this repo:
pi install ./packages/pi-peer
```

## What it adds

- `/peer help|setup|doctor|status|list|init|reconnect|resume|cancel|send|get|await|goal|scout`
- `peer_list`, `peer_send`, `peer_get`, `peer_await`, and `peer_progress` tools
- Local peer discovery and transport using project `.pi/peers.json`
- Repo-scoped discovery: only Pi sessions in the same git repo/project appear as local peers
- Idle watcher daemon: idle peers nudge stuck inbound activations and proactively inspect open goal-board work
- Persona-aware scout routing: goal-board suggestions include recommended lanes, preferred roles, claim mode, work keys, and rationale so proactive peers can self-select complementary work that fits their role/persona
- Protocol compatibility metadata (`protocolVersion`, min/max compatible versions), peer manifests, capabilities, and trust summaries in descriptors/status/list output
- `PI_PEER_ID` runtime override for running multiple local Pi sessions
- `pi-peer-publish` skill for safe npm release checks, version bumping, tag push, publish, and verification

## Setup and health checks

```bash
/peer setup --id planner --role planner
/peer doctor
/peer reconnect
/peer resume <message-id>
/peer cancel <message-id> "superseded"
```

`/peer setup` is a guided alias for `/peer init`: it creates `.pi/peers.json` only when the file is missing, seeds protocol/capability/trust manifest metadata, and never overwrites an existing config. `/peer doctor` is read-only and checks enablement, local identity, advertised endpoint, protocol compatibility, discovered peers, warnings, and resumable disconnected tasks. `/peer reconnect` refreshes local discovery after starting or restarting another Pi session. Discovery is repo/project scoped: sessions under the same `.git` root see each other, while sessions in other repos are ignored. Outside git, the resolved cwd is used as the scope. `/peer resume` re-dispatches a disconnected message restored from `.pi/peer-messages.json`; `/peer cancel` records a local cancellation so stale work is no longer treated as active. List-style flags such as `--peer`, `--path`, and `--claim` accept comma-separated values or repeated flags.

## Flat goal board

`/peer goal` provides a local blackboard for flat peer collaboration. Peers can create a shared goal, post findings/tasks/proposals/handoffs, claim read or write leases, object, resolve objections, scout for proactive next steps, and vote without a planner assigning every step.

Useful commands (long form and short aliases):

```bash
/peer goal create "Improve finalization safety" --constraint "one writer per path,no duplicate work,no destructive commands"
/peer goal fanout <goal-id> "Fix PR waiting path" --peer researcher,reviewer,worker --path extensions/symphony/index.ts,test/pr-watcher-runtime.test.mjs --send --no-await
/peer send worker "Fix PR waiting path" --goal <goal-id> --claim extensions/symphony/index.ts,test/pr-watcher-runtime.test.mjs --no-await
/peer progress "tests are running" --phase verification
/peer goal finding <goal-id> "PR auto-close can close before merge" --path extensions/symphony/index.ts
/peer scout <goal-id> --limit 5
/peer goal propose <goal-id> "Add a read-only reviewer before closing" --path extensions/symphony/index.ts
/peer goal claim <goal-id> "Fix PR waiting path" --mode write --path extensions/symphony/index.ts,test/pr-watcher-runtime.test.mjs --key implement:pr-waiting
/peer goal heartbeat <goal-id> <claim-event-id> "still working after reconnect" --stale-after-ms 900000
/peer goal release <goal-id> <claim-event-id> "worker lane complete"
/peer goal object <goal-id> "Missing merged-PR verification"
/peer goal vote <goal-id> pass "reviewed and verified" --confidence 0.9
/peer get <goal-id>
```

Short aliases keep common board updates terse: `/peer goals`/`/peer ls`, `/peer current`, `/peer scout`, `/peer fanout`, `/peer proposal`/`/peer propose`, `/peer take`/`/peer claim`, `/peer complete`/`/peer done`, `/peer objection`/`/peer block`, `/peer unblock`, `/peer note`, `/peer finding`, `/peer ping`/`/peer heartbeat`, `/peer drop`/`/peer release`, `/peer pass`, `/peer fail`, `/peer vote`, and `/peer close` map to the corresponding `/peer goal ...` actions.

The board is stored locally at `.pi/peer-goals.json`; outbound message snapshots are stored in `.pi/peer-messages.json` so restarted planners can still inspect disconnected historical tasks. Mutating goal-board operations take a short local lock before load/modify/save so concurrent peer appends do not drop events. `/peer send --goal <goal-id> --claim <path[,path]>` and the `peer_send` tool's `goalId`/`claimedPaths` parameters link long-running peer tasks to the board: Symphony records a task, claims overlapping write paths before dispatch, injects goal/heartbeat instructions into the peer prompt, keeps the claim alive with local heartbeats, and releases the claim after the peer returns a final response. Each goal-linked dispatch also gets a semantic work key (`goalId | lane | objective | mode | paths`) so duplicate read/review/research lanes are leased just like write paths; pass `--key <work-key>` / `workKey` for an explicit fingerprint and `--duplicate-policy allow-parallel` only when independent second opinions are intentional. The default dispatch policy is `reuse`, so a matching active work key returns the existing claim/task handle instead of starting another peer. `/peer goal fanout` turns a goal into role-specific peer lanes; planned fanouts create `planned` task rows, while `--send` records only the dispatched peer task so boards do not accumulate orphan `dispatching` placeholders. Scout suggestions are persona-aware: they surface a recommended lane (`research`, `review`, `implementation`, `coordination`, etc.), preferred roles, a safe default claim mode, a stable work key, rationale, and suppress suggestions already covered by active work keys. `/peer scout` prints the exact work key and a copyable `claim:` command for each read-only suggestion, and fulfilled proposal lanes also print a direct `resolve:` command. Empty goals emit multiple lane-specific read-only suggestions so idle peers can self-select research, review/QA, or implementation-planning work instead of waiting for a planner to assign lanes; goals with stale-only claims prompt stale-claim cleanup instead of generic new startup lanes. Lane-tagged proposals (for example `/peer goal propose <goal> "Check package contents" --lane review --key review:package-contents`) become matching scout suggestions that reuse the proposal work key, letting the next suitable peer claim or review that proposed lane and suppress duplicate suggestions while the lane is active. Active write claims conflict on overlapping paths; active semantic claims conflict on matching work keys; released, stale, or expired claims are kept visible but inactive. Completed goal-linked tasks are shown with their handoff status instead of remaining visually stuck as `running`. Claims become stale after 45 minutes without a heartbeat unless the claim or heartbeat sets `--stale-after-ms`.

Normal goal closure requires at least one current passing vote, no current failed votes, no unresolved blocking objections, no active claims or running tasks, and no unresolved open proposals. Proposals let peers show initiative, then must be resolved or explicitly deferred before normal closure so the final handoff reflects human intent; use `--force` only when intentionally overriding that readiness gate. Stale claims no longer block closure or new overlapping claims; use `/peer goal heartbeat` to revive work after a reconnect. Goal-linked tasks validate final handoff headings (`Status`, `Files changed`, `Verification`, `Blockers/risks`, `Safe for review`); missing sections create a blocking objection while still releasing the write claim. For multi-part work, use the fan-out gate: list peers, create/reuse a goal, delegate research/review/worker lanes, and include `Fan-out used: yes/no` plus peer handles in the final answer.

## Idle watcher

When peer messaging is enabled, the extension starts a lightweight in-process idle watcher on `session_start`. It only acts when Pi reports the agent is idle and there are no queued local follow-up messages. The watcher does two things:

1. If an inbound peer task is active but appears not to have triggered a turn, it re-nudges the existing inbound prompt with `triggerTurn: true` using a cooldown.
2. If no peer task is active, it reads `.pi/peer-goals.json`, derives the same read-only scout suggestions as `/peer scout`, and injects a concise self-prompt so the idle peer can propose, review, claim, vote, or no-op safely. When the local peer has a configured `role` or `persona`, the watcher prefers suggestions whose lane matches that profile and leaves mismatched work for better-fit peers.

Configuration can be placed in `.pi/peers.json` as `idleWatcher` or in `.pi/settings.json` under `peerMessaging.idleWatcher`:

```json
{
  "idleWatcher": {
    "enabled": true,
    "intervalMs": 15000,
    "cooldownMs": 300000,
    "maxActivationsPerSession": 20
  }
}
```

Set `PI_PEER_IDLE_WATCHER=off` to disable it for a process. `PI_PEER_IDLE_WATCHER_INTERVAL_MS` and `PI_PEER_IDLE_WATCHER_COOLDOWN_MS` override timing for local testing.

## Package checks

```bash
npm test
npm run check:pack
npm run smoke:pack
npm run check
```

## Publish to npm

This package includes a `pi-peer-publish` Pi skill. Ask Pi to use it, or run `/skill:pi-peer-publish`, when you want an agent-guided release with safety checks, version bumping, tag push, publish, and npm verification.

Use this manual release workflow after landing package changes on `main`:

```bash
# Keep local peer runtime state out of release commits.
echo ".pi/" >> .git/info/exclude

# Verify the package before changing the version.
git status --short
npm run check

# Bump, commit, and tag the next patch version.
npm version patch

# Push the release commit and tag, then publish.
git push origin main --tags
npm publish --access public
```

If `npm version patch` reports `Git working directory not clean`, inspect `git status --short`. Do not commit `.pi/`; add it to `.git/info/exclude` or remove local runtime files. If `package.json` was already bumped by the failed command, either commit/tag it manually or reset `package.json` and rerun `npm version patch`.

## Notes

This package is MIT licensed and published from <https://github.com/CryptoLibertus/pi-peer>. Please use GitHub issues for bugs and feature requests. Peer writes and project mutations still depend on the receiving Pi session's normal approval and safety rules.
