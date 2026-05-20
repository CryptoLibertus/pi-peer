# @cryptolibertus/pi-peer

Pi package for local Pi-to-Pi peer messaging.

## Install

```bash
pi install npm:@cryptolibertus/pi-peer
# or while developing from this repo:
pi install ./packages/pi-peer
```

## What it adds

- `/peer help|setup|doctor|status|list|init|reconnect|resume|cancel|send|get|await|goal`
- `peer_list`, `peer_send`, `peer_get`, `peer_await`, and `peer_progress` tools
- Local peer discovery and transport using project `.pi/peers.json`
- Protocol compatibility metadata (`protocolVersion`, min/max compatible versions), peer manifests, capabilities, and trust summaries in descriptors/status/list output
- `PI_PEER_ID` runtime override for running multiple local Pi sessions

## Setup and health checks

```bash
/peer setup --id planner --role planner
/peer doctor
/peer reconnect
/peer resume <message-id>
/peer cancel <message-id> "superseded"
```

`/peer setup` is a guided alias for `/peer init`: it creates `.pi/peers.json` only when the file is missing, seeds protocol/capability/trust manifest metadata, and never overwrites an existing config. `/peer doctor` is read-only and checks enablement, local identity, advertised endpoint, protocol compatibility, discovered peers, warnings, and resumable disconnected tasks. `/peer reconnect` refreshes local discovery after starting or restarting another Pi session. `/peer resume` re-dispatches a disconnected message restored from `.pi/peer-messages.json`; `/peer cancel` records a local cancellation so stale work is no longer treated as active.

## Flat goal board

`/peer goal` provides a local blackboard for flat peer collaboration. Peers can create a shared goal, post findings/tasks/handoffs, claim read or write leases, object, resolve objections, and vote without a planner assigning every step.

Useful commands (long form and short aliases):

```bash
/peer goal create "Improve finalization safety" --constraint "one writer per path,no destructive commands"
/peer goal fanout <goal-id> "Fix PR waiting path" --peer researcher,reviewer,worker --path extensions/symphony/index.ts,test/pr-watcher-runtime.test.mjs --send --no-await
/peer send worker "Fix PR waiting path" --goal <goal-id> --claim extensions/symphony/index.ts,test/pr-watcher-runtime.test.mjs --no-await
/peer progress "tests are running" --phase verification
/peer goal finding <goal-id> "PR auto-close can close before merge" --path extensions/symphony/index.ts
/peer goal claim <goal-id> "Fix PR waiting path" --mode write --path extensions/symphony/index.ts,test/pr-watcher-runtime.test.mjs
/peer goal heartbeat <goal-id> <claim-event-id> "still working after reconnect" --stale-after-ms 900000
/peer goal release <goal-id> <claim-event-id> "worker lane complete"
/peer goal object <goal-id> "Missing merged-PR verification"
/peer goal vote <goal-id> pass "reviewed and verified" --confidence 0.9
/peer get <goal-id>
```

Short aliases keep common board updates terse: `/peer goals`/`/peer ls`, `/peer current`, `/peer fanout`, `/peer take`/`/peer claim`, `/peer complete`/`/peer done`, `/peer objection`/`/peer block`, `/peer unblock`, `/peer note`, `/peer finding`, `/peer ping`/`/peer heartbeat`, `/peer drop`/`/peer release`, `/peer pass`, `/peer fail`, `/peer vote`, and `/peer close` map to the corresponding `/peer goal ...` actions.

The board is stored locally at `.pi/peer-goals.json`; outbound message snapshots are stored in `.pi/peer-messages.json` so restarted planners can still inspect disconnected historical tasks. Mutating goal-board operations take a short local lock before load/modify/save so concurrent peer appends do not drop events. `/peer send --goal <goal-id> --claim <path[,path]>` and the `peer_send` tool's `goalId`/`claimedPaths` parameters link long-running peer tasks to the board: Symphony records a task, claims overlapping write paths before dispatch, injects goal/heartbeat instructions into the peer prompt, keeps the claim alive with local heartbeats, and releases the claim after the peer returns a final response. `/peer goal fanout` turns a goal into role-specific peer lanes, while `peer_progress` reports checkpoints from an inbound long-running task. Active write claims conflict on overlapping paths; released, stale, or expired claims are kept visible but inactive. Claims become stale after 45 minutes without a heartbeat unless the claim or heartbeat sets `--stale-after-ms`.

Normal goal closure requires at least one current passing vote, no current failed votes, no unresolved blocking objections, and no active write claims. Stale write claims no longer block closure or new overlapping claims; use `/peer goal heartbeat` to revive work after a reconnect and `--force` only when intentionally overriding the readiness gate. Goal-linked tasks validate final handoff headings (`Status`, `Files changed`, `Verification`, `Blockers/risks`, `Safe for review`); missing sections create a blocking objection while still releasing the write claim. For multi-part work, use the fan-out gate: list peers, create/reuse a goal, delegate research/review/worker lanes, and include `Fan-out used: yes/no` plus peer handles in the final answer.

## Package checks

```bash
npm --prefix packages/pi-peer test
npm --prefix packages/pi-peer run check:pack
npm --prefix packages/pi-peer run smoke:pack
npm --prefix packages/pi-peer run check
```

## Notes

This package is MIT licensed and published from <https://github.com/CryptoLibertus/pi-peer>. Please use GitHub issues for bugs and feature requests. Peer writes and project mutations still depend on the receiving Pi session's normal approval and safety rules.
