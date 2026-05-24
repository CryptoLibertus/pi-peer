export function formatPeerHelp() {
  return [
    "# Peer Commands",
    "",
    "- `/peer setup` — open the interactive setup/spawn wizard; non-UI fallback supports `/peer setup 1`, `/peer setup subagents`, `/peer setup reset`, or legacy setup flags",
    "- `/peer center` — open the peer command center facade",
    "- `/peer work` — open a compact TUI launcher that pre-fills common peer work commands",
    "- `/peer do <intent> [args...]` or `/peer do <objective>` `[--constraint <a,b>] [--path <a,b>] [--lane <a,b>]` — run a high-level peer workflow intent or start a natural-language mission",
    "- `/peer accomplish <objective>` — alias for `/peer do mission <objective>`",
    "- `/peer subrun status|start|progress|complete|cancel ...` — coordinate subagent run status and evidence",
    "- `/peer spawn <peer-id[,peer-id]> [--role worker] [--subagents]` — launch managed headless Pi RPC peers from this one session; use `/peer spawn status` and `/peer spawn stop [peer-id]`",
    "- `/peer factory init|status|run|gate|attempt|rework|plan-review|metrics ...` — coordinate factory control-plane runs, gates, attempts, and metrics",
    "- `/peer factory automate status|init|run|record ...` — inspect and record optional automation recommendations without executing them",
    "- `/peer factory pr status|record|commands ...` — record PR lifecycle events and print suggested PR commands without executing them",
    "- `/peer metrics` — alias for `/peer factory metrics`",
    "- `/peer status` — show local peer runtime, endpoint/auth, discovered peers, pending messages, context pressure, and warnings",
    "- `/peer context` — show local context usage/pressure when Pi exposes it to extensions",
    "- `/peer context status|patch|eval|retro ...` — inspect and append context-as-code lifecycle ledger records",
    "- `/peer list` — list configured and discovered peers",
    "- `/peer setup [--id <peer-id>] [--role planner|worker|reviewer] [--domain <domain>] [--subagents] [--peer <peer-id>]` — guided alias for creating .pi/peers.json with protocol/capability metadata; never overwrites",
    "- `/peer init [--id <peer-id>]` — create .pi/peers.json if missing; never overwrites",
    "- `/peer org init [--id <peer-id>] [--role coordinator] [--domain coordination] [--subagents true|false]` — create .pi/peer-org.json role/domain charter; never overwrites",
    "- `/peer org status` — show peer manager roles, domains, spawn policy, and evidence policy",
    "- `/peer org role set <peer-id> --role <role> [--domain <domain>] [--subagents true|false]` — assign a top-level peer manager role/domain in .pi/peer-org.json",
    "- `/peer doctor` — check peer config, protocol compatibility, endpoint, discovered peers, and resumable tasks",
    "- `/peer reconnect` — refresh local discovery and show current status",
    "- `/peer resume <message-id>` — resume a disconnected restored peer message after reconnect",
    "- `/peer cancel <message-id> [reason]` — mark a queued/running/disconnected peer message cancelled",
    "- `/peer send <peer> <prompt> [--no-await] [--intent ask] [--goal <goal-id>] [--claim <path[,path]>] [--key <work-key>] [--duplicate-policy reuse|error|allow-parallel]` — send a prompt-first peer message",
    "- `/peer progress <summary> [--status running] [--phase <name>]` — send a structured checkpoint from an inbound long-running peer task",
    "- `/peer hive start <objective> [--constraint <a,b>] [--path <a,b>] [--lane research,review,implementation]` — create a goal, seed read-only self-selection proposals, and print scout commands without dispatching peers",
    "- `/peer hive run <objective> --duration <5h|30m|300s> [--peer <id[,id]>] [--interval-ms <ms>] [--lane research,review,implementation]` — start a bounded closed-loop supervisor that dispatches read-only peer lanes until duration expires",
    "- `/peer hive status|stop <goal-id>` — inspect or stop an in-process hive run supervisor",
    "- `/peer self-improve init|status|run <objective> [--loops <1-100>] [--duration <5h|30m|300s>] [--peer <id[,id]>] [--dispatch] [--path <a,b>] [--eval <cmd>] [--auto-commit]` — initialize and run bounded recursive self-improvement experiments with safe defaults",
    "- `/peer goals|ls`, `/peer current [goal-id]`, `/peer scout [goal-id]`, `/peer dashboard [goal-id]`, `/peer fanout`, `/peer propose`, `/peer take|claim`, `/peer complete|done`, `/peer objection|block`, `/peer unblock`, `/peer ping`, `/peer drop`, `/peer pass|fail` — short goal-board aliases",
    "- `/peer goal create <objective> [--constraint <a,b>] [--min-votes <n>] [--min-independent-votes <n>]` — start a flat shared goal board",
    "- `/peer goal list|show [goal-id]` — inspect peer goals, active claims, blockers, proposals, and votes",
    "- `/peer goal fanout <goal-id> <objective> --peer <id[,id]> [--path <a,b>] [--send] [--no-await] [--duplicate-policy reuse|error|allow-parallel]` — plan or dispatch role-specific peer lanes",
    "- `/peer goal scout [goal-id] [--limit <n>] [--include-closed]` — read-only proactive suggestions with exact work keys and copyable claim commands for what peers could do next",
    "- `/peer goal task|finding|proposal|handoff|note <goal-id> <summary> [--path <a,b>] [--lane research|review|implementation] [--status done]` — post goal-board events; lane-tagged proposals become scout suggestions peers can self-select",
    "- `/peer goal plan <goal-id> <objective> [--lane research,implementation,review] [--path <a,b>]` — expand an objective into dependency-gated work items and lane proposals",
    "- `/peer goal item <goal-id> <summary> --item-id <id> [--status open|done] [--depends-on <id[,id]>] [--parent <id>]` — add/update first-class epic work items that gate closure until done and dependencies are satisfied",
    "- `/peer goal claim <goal-id> <task> --mode read|write|--write --lane <lane> --path <a,b> [--key <work-key>] [--duplicate-policy reuse|error|allow-parallel] [--ttl-ms <ms>] [--stale-after-ms <ms>]` — lease work without hierarchy",
    "- `/peer goal heartbeat <goal-id> <claim-event-id> [summary] [--ttl-ms <ms>] [--stale-after-ms <ms>]` — refresh a live or stale claim and optionally extend its stale window",
    "- `/peer goal release <goal-id> <claim-event-id> [summary]` — release a claimed lane",
    "- `/peer goal object <goal-id> <reason> [--path <a,b>]`, `/peer goal resolve <goal-id> <event-id> <summary>`, `/peer goal vote <goal-id> <pass|fail|pass-with-risks> [summary]`",
    "- `/peer get <peer|message|conversation|runtime|audit|goals|goal-id>` — inspect peer state",
    "- `/peer await <message-id> [...message-id] [--timeout-ms <ms>]` — wait for queued peer replies",
    "- `/peer help` — show this help",
  ].join("\n");
}

export function formatPeerInitResult(result) {
  if (result.created) return `Created ${result.relativePath || ".pi/peers.json"}. Edit it to add trusted peers before sending work.`;
  return `${result.relativePath || ".pi/peers.json"} already exists; left it unchanged.`;
}

export function formatPeerCommandError(message) {
  return `${message}\n\nRun \`/peer help\` for usage.`;
}
