import { flagEnabled, parseFlags, splitCommandLine } from "../utils.mjs";

export const PEER_COMMANDS = Object.freeze(["help", "status", "context", "list", "init", "setup", "doctor", "reconnect", "resume", "cancel", "send", "get", "await", "progress", "goal", "hive", "swarm", "self-improve", "improve"]);

const PEER_GOAL_ALIASES = Object.freeze({
  goals: ["list"],
  ls: ["list"],
  current: ["show"],
  fanout: ["fanout"],
  scout: ["scout"],
  dashboard: ["dashboard"],
  proposal: ["proposal"],
  propose: ["propose"],
  item: ["item"],
  "work-item": ["work-item"],
  claim: ["claim"],
  take: ["claim"],
  heartbeat: ["heartbeat"],
  ping: ["heartbeat"],
  release: ["release"],
  drop: ["release"],
  finding: ["finding"],
  note: ["note"],
  handoff: ["handoff"],
  done: ["handoff", "--status", "done"],
  complete: ["handoff", "--status", "done"],
  block: ["object"],
  objection: ["object"],
  object: ["object"],
  resolve: ["resolve"],
  unblock: ["resolve"],
  vote: ["vote"],
  close: ["close"],
});

export function parsePeerCommand(rawArgs = "") {
  const parts = splitCommandLine(rawArgs);
  const first = parts[0] && !parts[0].startsWith("--") ? parts.shift() : "status";
  if (first === "pass" || first === "fail") {
    const [goalId, ...rest] = parts;
    const aliasParts = ["vote", goalId, first, ...rest].filter(Boolean);
    const { flags, positionals } = parseFlags(aliasParts);
    return parsePeerGoalCommand({ subcommand: "goal", flags, positionals, rawArgs }, flags, positionals);
  }
  if (first && PEER_GOAL_ALIASES[first]) {
    const aliasParts = [...PEER_GOAL_ALIASES[first], ...parts];
    const { flags, positionals } = parseFlags(aliasParts);
    return parsePeerGoalCommand({ subcommand: "goal", flags, positionals, rawArgs }, flags, positionals);
  }
  const subcommand = PEER_COMMANDS.includes(first || "") ? first || "status" : "help";
  const { flags, positionals } = parseFlags(parts);
  const parsed = { subcommand, flags, positionals, rawArgs };

  if (first && !PEER_COMMANDS.includes(first)) return { ...parsed, error: `Unknown /peer command '${first}'` };
  if (subcommand === "send") {
    const peerId = positionals[0];
    const prompt = positionals.slice(1).join(" ").trim();
    if (!peerId || !prompt) return { ...parsed, error: "/peer send requires <peer> <prompt>" };
    const goalId = stringFlag(flags.goal || flags.goalId, undefined);
    const claimedPaths = claimedPathsFlag(flags.claim || flags.claimedPath || flags.claimedPaths);
    return {
      ...parsed,
      peerId,
      prompt,
      intent: stringFlag(flags.intent, "ask"),
      awaitResponse: !flagEnabled(flags.noAwait) && flagDefaultEnabled(flags.await, true),
      timeoutMs: positiveIntegerFlag(flags.timeoutMs),
      maxHopCount: positiveIntegerFlag(flags.maxHopCount),
      allowSelf: flagEnabled(flags.allowSelf),
      goalId,
      goalClaimMode: stringFlag(flags.claimMode, undefined),
      goalStaleAfterMs: positiveIntegerFlag(flags.staleAfterMs),
      workKey: stringFlag(flags.workKey || flags.key, undefined),
      workLane: stringFlag(flags.workLane || flags.lane, undefined),
      duplicatePolicy: stringFlag(flags.duplicatePolicy, undefined),
      isolationMode: isolationModeFromFlags(flags),
      claimedPaths,
      metadata: metadataFromFlags(flags, { goalId, claimedPaths, workKey: stringFlag(flags.workKey || flags.key, undefined), workLane: stringFlag(flags.workLane || flags.lane, undefined), duplicatePolicy: stringFlag(flags.duplicatePolicy, undefined), isolationMode: isolationModeFromFlags(flags) }),
    };
  }
  if (subcommand === "goal") {
    return parsePeerGoalCommand(parsed, flags, positionals);
  }
  if (subcommand === "hive" || subcommand === "swarm") {
    return parsePeerHiveCommand(parsed, flags, positionals);
  }
  if (subcommand === "self-improve" || subcommand === "improve") {
    return parsePeerSelfImproveCommand(parsed, flags, positionals);
  }
  if (subcommand === "progress") {
    const summary = positionals.join(" ").trim();
    if (!summary) return { ...parsed, error: "/peer progress requires <summary>" };
    return { ...parsed, summary, status: stringFlag(flags.status, undefined), phase: stringFlag(flags.phase, undefined), detail: stringFlag(flags.detail, undefined) };
  }
  if (subcommand === "resume") {
    const messageId = positionals[0];
    if (!messageId) return { ...parsed, error: "/peer resume requires <message-id>" };
    return { ...parsed, messageId };
  }
  if (subcommand === "cancel") {
    const messageId = positionals[0];
    const reason = positionals.slice(1).join(" ").trim() || "cancelled by sender";
    if (!messageId) return { ...parsed, error: "/peer cancel requires <message-id> [reason]" };
    return { ...parsed, messageId, reason };
  }
  if (subcommand === "get") {
    const id = positionals[0];
    if (!id) return { ...parsed, error: "/peer get requires <id>" };
    return { ...parsed, id };
  }
  if (subcommand === "await") {
    const messageIds = positionals.filter(Boolean);
    if (messageIds.length === 0) return { ...parsed, error: "/peer await requires <message-id> [message-id...]" };
    return { ...parsed, messageIds, timeoutMs: positiveIntegerFlag(flags.timeoutMs) };
  }
  if (subcommand === "init" || subcommand === "setup") {
    const localPeerId = stringFlag(flags.id || flags.localPeerId, undefined);
    const role = stringFlag(flags.role, undefined);
    const persona = stringFlag(flags.persona, undefined);
    const trust = stringFlag(flags.trust, undefined);
    const capabilities = capabilitiesFromFlags(flags);
    const peer = stringFlag(flags.peer, undefined);
    const peerRole = stringFlag(flags.peerRole, undefined);
    const peerTrust = stringFlag(flags.peerTrust, undefined);
    const peerCapabilities = capabilitiesFromFlags({ intents: flags.peerIntents });
    const seedPeers = peer ? { [peer]: { ...(peerRole ? { role: peerRole } : {}), ...(peerTrust ? { trust: peerTrust } : {}), ...(Object.keys(peerCapabilities).length ? { capabilities: peerCapabilities } : {}) } } : undefined;
    return stripUndefined({
      ...parsed,
      localPeerId,
      role,
      persona,
      trust,
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
      seedPeers,
      enabled: !flagEnabled(flags.disabled),
    });
  }
  return parsed;
}

export function formatPeerHelp() {
  return [
    "# Peer Commands",
    "",
    "- `/peer status` — show local peer runtime, endpoint/auth, discovered peers, pending messages, context pressure, and warnings",
    "- `/peer context` — show local context usage/pressure when Pi exposes it to extensions",
    "- `/peer list` — list configured and discovered peers",
    "- `/peer setup [--id <peer-id>] [--role planner|worker|reviewer] [--peer <peer-id>]` — guided alias for creating .pi/peers.json with protocol/capability metadata; never overwrites",
    "- `/peer init [--id <peer-id>]` — create .pi/peers.json if missing; never overwrites",
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
    "- `/peer goal create <objective> [--constraint <a,b>]` — start a flat shared goal board",
    "- `/peer goal list|show [goal-id]` — inspect peer goals, active claims, blockers, proposals, and votes",
    "- `/peer goal fanout <goal-id> <objective> --peer <id[,id]> [--path <a,b>] [--send] [--no-await]` — plan or dispatch role-specific peer lanes",
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

function parsePeerHiveCommand(parsed, flags, positionals) {
  const action = positionals[0] || "start";
  const rest = positionals.slice(1);
  const withAction = { ...parsed, hiveAction: action };
  if (!["start", "run", "status", "stop"].includes(action)) return { ...withAction, error: `Unknown /peer ${parsed.subcommand} action '${action}'` };
  if (["status", "stop"].includes(action)) {
    const goalId = rest[0];
    if (!goalId) return { ...withAction, error: `/peer ${parsed.subcommand} ${action} requires <goal-id>` };
    return { ...withAction, goalId };
  }
  const objective = rest.join(" ").trim();
  if (!objective) return { ...withAction, error: `/peer ${parsed.subcommand} ${action} requires <objective>` };
  const durationMs = durationFlag(flags.duration || flags.for || flags.timebox);
  if (action === "run" && !durationMs) return { ...withAction, error: `/peer ${parsed.subcommand} run requires --duration <5h|30m|300s>` };
  return {
    ...withAction,
    objective,
    constraints: listFlag(flags.constraint || flags.constraints),
    paths: listFlag(flags.path || flags.paths),
    lanes: listFlag(flags.lane || flags.lanes),
    proposals: listFlag(flags.proposal || flags.proposals),
    peers: listFlag(flags.peer || flags.peers),
    durationMs,
    intervalMs: positiveIntegerFlag(flags.intervalMs) || positiveIntegerFlag(flags.interval),
    awaitResponse: flagEnabled(flags.await),
    send: action === "run" || flagEnabled(flags.send),
    write: flagEnabled(flags.write),
  };
}

function durationFlag(value) {
  if (Array.isArray(value)) return durationFlag(value.at(-1));
  if (value === undefined || value === true) return undefined;
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const unit = match[2];
  const factor = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const ms = Math.round(number * factor);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

function parsePeerSelfImproveCommand(parsed, flags, positionals) {
  const action = positionals[0] || "status";
  const rest = positionals.slice(1);
  const withAction = { ...parsed, selfImproveAction: action };
  if (!["init", "status", "run"].includes(action)) return { ...withAction, error: `Unknown /peer ${parsed.subcommand} action '${action}'` };
  if (action === "init") return { ...withAction, overwrite: flagEnabled(flags.overwrite) };
  if (action === "status") return withAction;
  const objective = rest.join(" ").trim();
  if (!objective) return { ...withAction, error: `/peer ${parsed.subcommand} run requires <objective>` };
  const loopFlag = firstDefined(flags.loops, flags.loop);
  const loops = loopFlag === undefined ? 10 : positiveIntegerFlag(loopFlag);
  if (!loops) return { ...withAction, error: `/peer ${parsed.subcommand} run requires --loops to be a positive integer` };
  if (loops > 100) return { ...withAction, error: `/peer ${parsed.subcommand} run is bounded to --loops 100 or fewer` };
  return {
    ...withAction,
    objective,
    loops,
    durationMs: durationFlag(flags.duration || flags.for || flags.timebox),
    intervalMs: positiveIntegerFlag(flags.intervalMs) || positiveIntegerFlag(flags.interval),
    peers: listFlag(flags.peer || flags.peers),
    paths: listFlag(flags.path || flags.paths),
    lanes: listFlag(flags.lane || flags.lanes),
    evals: listFlag(flags.eval || flags.evals || flags.check || flags.checks),
    dispatch: flagEnabled(flags.dispatch || flags.send),
    autoCommit: flagEnabled(flags.autoCommit || flags.commit),
  };
}

function parsePeerGoalCommand(parsed, flags, positionals) {
  const action = positionals[0] || "list";
  const rest = positionals.slice(1);
  const withAction = { ...parsed, goalAction: action };
  if (action === "list") return withAction;
  if (action === "create") {
    const objective = rest.join(" ").trim();
    if (!objective) return { ...withAction, error: "/peer goal create requires <objective>" };
    return { ...withAction, objective, constraints: listFlag(flags.constraint || flags.constraints) };
  }
  if (action === "show") return { ...withAction, goalId: rest[0] };
  if (action === "dashboard") return { ...withAction, goalId: rest[0] };
  if (action === "scout") return { ...withAction, goalId: rest[0], limit: positiveIntegerFlag(flags.limit), includeClosed: flagEnabled(flags.includeClosed) };
  if (action === "fanout") {
    const goalId = rest[0];
    const objective = rest.slice(1).join(" ").trim();
    const peers = listFlag(flags.peer || flags.peers);
    if (!goalId || !objective) return { ...withAction, error: "/peer goal fanout requires <goal-id> <objective> --peer <id[,id]>" };
    if (!peers.length) return { ...withAction, error: "/peer goal fanout requires --peer <id[,id]>" };
    return {
      ...withAction,
      goalId,
      objective,
      peers,
      paths: listFlag(flags.path || flags.paths),
      send: flagEnabled(flags.send),
      awaitResponse: !flagEnabled(flags.noAwait) && flagDefaultEnabled(flags.await, true),
      timeoutMs: positiveIntegerFlag(flags.timeoutMs),
      staleAfterMs: positiveIntegerFlag(flags.staleAfterMs),
    };
  }
  if (action === "plan" || action === "schedule") {
    const goalId = rest[0];
    const objective = rest.slice(1).join(" ").trim();
    if (!goalId || !objective) return { ...withAction, error: `/peer goal ${action} requires <goal-id> <objective>` };
    return { ...withAction, goalId, objective, lanes: listFlag(flags.lane || flags.lanes), paths: listFlag(flags.path || flags.paths), workKeyPrefix: stringFlag(flags.keyPrefix || flags.prefix, undefined) };
  }
  if (["task", "finding", "proposal", "propose", "handoff", "note", "item", "work-item"].includes(action)) {
    const goalId = rest[0];
    const summary = rest.slice(1).join(" ").trim();
    if (!goalId || !summary) return { ...withAction, error: `/peer goal ${action} requires <goal-id> <summary>` };
    const eventType = action === "propose" ? "proposal" : ["item", "work-item"].includes(action) ? "work-item" : action;
    const dependsFlag = firstDefined(flags.dependsOn, flags.depends, flags.dependency, flags.dependencies);
    return { ...withAction, goalId, eventType, summary, paths: listFlag(flags.path || flags.paths), severity: stringFlag(flags.severity, undefined), taskId: stringFlag(flags.taskId, undefined), itemId: stringFlag(flags.itemId || flags.item || flags.id, undefined), parentId: stringFlag(flags.parentId || flags.parent, undefined), dependsOn: dependsFlag === undefined ? undefined : listFlag(dependsFlag), status: stringFlag(flags.status, undefined), workKey: stringFlag(flags.workKey || flags.key, undefined), workLane: stringFlag(flags.workLane || flags.lane, undefined), duplicatePolicy: stringFlag(flags.duplicatePolicy, undefined), metadata: qualityMetadataFromFlags(flags) };
  }
  if (action === "claim") {
    if (flagEnabled(flags.write) && flags.mode === undefined) flags.mode = "write";
    const goalId = rest[0];
    const summary = rest.slice(1).join(" ").trim();
    if (!goalId || !summary) return { ...withAction, error: "/peer goal claim requires <goal-id> <task>" };
    return { ...withAction, goalId, summary, paths: listFlag(flags.path || flags.paths), mode: stringFlag(flags.mode, "read"), workKey: stringFlag(flags.workKey || flags.key, undefined), workLane: stringFlag(flags.workLane || flags.lane, undefined), duplicatePolicy: stringFlag(flags.duplicatePolicy, undefined), ttlMs: positiveIntegerFlag(flags.ttlMs), staleAfterMs: positiveIntegerFlag(flags.staleAfterMs) };
  }
  if (action === "heartbeat") {
    const goalId = rest[0];
    const resolves = rest[1];
    const summary = rest.slice(2).join(" ").trim() || `Heartbeat for ${resolves || "claim"}`;
    if (!goalId || !resolves) return { ...withAction, error: "/peer goal heartbeat requires <goal-id> <claim-event-id> [summary]" };
    return { ...withAction, goalId, resolves, summary, ttlMs: positiveIntegerFlag(flags.ttlMs), staleAfterMs: positiveIntegerFlag(flags.staleAfterMs) };
  }
  if (action === "release") {
    const goalId = rest[0];
    const resolves = rest[1];
    const summary = rest.slice(2).join(" ").trim() || `Released ${resolves || "claim"}`;
    if (!goalId || !resolves) return { ...withAction, error: "/peer goal release requires <goal-id> <claim-event-id> [summary]" };
    return { ...withAction, goalId, resolves, summary };
  }
  if (action === "object") {
    const goalId = rest[0];
    const summary = rest.slice(1).join(" ").trim();
    if (!goalId || !summary) return { ...withAction, error: "/peer goal object requires <goal-id> <reason>" };
    return { ...withAction, goalId, summary, paths: listFlag(flags.path || flags.paths), severity: stringFlag(flags.severity, "blocking") };
  }
  if (action === "resolve") {
    const goalId = rest[0];
    const resolves = rest[1];
    const summary = rest.slice(2).join(" ").trim() || `Resolved ${resolves || "objection"}`;
    if (!goalId || !resolves) return { ...withAction, error: "/peer goal resolve requires <goal-id> <event-id> [summary]" };
    return { ...withAction, goalId, resolves, summary };
  }
  if (action === "vote") {
    const goalId = rest[0];
    const verdict = rest[1];
    const summary = rest.slice(2).join(" ").trim();
    if (!goalId || !verdict) return { ...withAction, error: "/peer goal vote requires <goal-id> <pass|fail|pass-with-risks> [summary]" };
    return { ...withAction, goalId, verdict, summary, confidence: flags.confidence };
  }
  if (action === "close") {
    const goalId = rest[0];
    const summary = rest.slice(1).join(" ").trim();
    if (!goalId) return { ...withAction, error: "/peer goal close requires <goal-id>" };
    return { ...withAction, goalId, summary, force: flagEnabled(flags.force) };
  }
  return { ...withAction, error: `Unknown /peer goal action '${action}'` };
}

function stringFlag(value, fallback) {
  if (Array.isArray(value)) return stringFlag(value.at(-1), fallback);
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function flagDefaultEnabled(value, fallback = false) {
  if (Array.isArray(value)) return flagDefaultEnabled(value.at(-1), fallback);
  if (value === undefined) return fallback;
  return flagEnabled(value);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function positiveIntegerFlag(value) {
  if (Array.isArray(value)) return positiveIntegerFlag(value.at(-1));
  if (value === undefined || value === true) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function qualityMetadataFromFlags(flags = {}) {
  const citations = listFlag(flags.citation || flags.citations || flags.source || flags.sources || flags.reference || flags.references);
  const factChecks = listFlag(flags.factCheck || flags.factChecks || flags.verifiedClaim || flags.verifiedClaims);
  const limitations = listFlag(flags.limitation || flags.limitations || flags.assumption || flags.assumptions || flags.uncertainty || flags.unknowns);
  const confidence = ratioFlag(flags.confidence);
  const quality = {
    ...(citations.length ? { citations } : {}),
    ...(factChecks.length ? { factChecks } : {}),
    ...(limitations.length ? { limitations } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
  return Object.keys(quality).length ? { quality } : undefined;
}

function ratioFlag(value) {
  if (Array.isArray(value)) return ratioFlag(value.at(-1));
  if (value === undefined || value === true) return undefined;
  const text = String(value).trim();
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent / 100 : undefined;
  }
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
}

function metadataFromFlags(flags = {}, options = {}) {
  const claimedPaths = options.claimedPaths || claimedPathsFlag(flags.claim || flags.claimedPath || flags.claimedPaths);
  const goalId = options.goalId || stringFlag(flags.goal || flags.goalId, undefined);
  const workKey = options.workKey || stringFlag(flags.workKey || flags.key, undefined);
  const workLane = options.workLane || stringFlag(flags.workLane || flags.lane, undefined);
  const duplicatePolicy = options.duplicatePolicy || stringFlag(flags.duplicatePolicy, undefined);
  const isolationMode = options.isolationMode || isolationModeFromFlags(flags);
  return {
    ...(claimedPaths.length ? { claimedPaths } : {}),
    ...(goalId ? { goalId } : {}),
    ...(workKey ? { workKey } : {}),
    ...(workLane ? { workLane } : {}),
    ...(duplicatePolicy ? { duplicatePolicy } : {}),
    ...(isolationMode ? { isolationMode } : {}),
  };
}

function isolationModeFromFlags(flags = {}) {
  if (flagEnabled(flags.worktree)) return "worktree";
  return stringFlag(flags.isolation || flags.isolationMode, undefined);
}

function claimedPathsFlag(value) {
  return listFlag(value);
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function capabilitiesFromFlags(flags = {}) {
  const capabilities = {};
  const intents = listFlag(flags.intents);
  if (intents.length) capabilities.intents = intents;
  if (flagEnabled(flags.write) || flagEnabled(flags.writeAccess)) capabilities.writeAccess = true;
  if (flagEnabled(flags.readOnly)) capabilities.writeAccess = false;
  return capabilities;
}

function listFlag(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((item) => {
    if (typeof item !== "string") return [];
    return item.split(",").map((part) => part.trim()).filter(Boolean);
  }))];
}
