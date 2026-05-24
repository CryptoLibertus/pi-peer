import { flagEnabled, parseFlags, splitCommandLine } from "../utils.mjs";
import { formatPeerCommandError, formatPeerHelp, formatPeerInitResult } from "./command-help.mjs";
export { formatPeerCommandError, formatPeerHelp, formatPeerInitResult } from "./command-help.mjs";

export const PEER_COMMANDS = Object.freeze(["help", "status", "context", "list", "center", "work", "init", "setup", "do", "mission", "accomplish", "subrun", "spawn", "org", "doctor", "reconnect", "resume", "cancel", "send", "get", "await", "progress", "goal", "hive", "swarm", "self-improve", "improve", "factory", "metrics"]);

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
  if (subcommand === "context") {
    return parsePeerContextCommand(parsed, flags, positionals);
  }
  if (subcommand === "hive" || subcommand === "swarm") {
    return parsePeerHiveCommand(parsed, flags, positionals);
  }
  if (subcommand === "do") {
    return parsePeerDoCommand(parsed, flags, positionals);
  }
  if (subcommand === "mission" || subcommand === "accomplish") {
    return parsePeerDoCommand({ ...parsed, subcommand: "do", facadeCommand: subcommand }, flags, ["mission", ...positionals]);
  }
  if (subcommand === "subrun") {
    return parsePeerSubrunCommand(parsed, flags, positionals);
  }
  if (subcommand === "spawn") {
    return parsePeerSpawnCommand(parsed, flags, positionals);
  }
  if (subcommand === "factory") {
    return parsePeerFactoryCommand(parsed, flags, positionals);
  }
  if (subcommand === "metrics") {
    return parsePeerFactoryCommand({ ...parsed, subcommand: "factory", positionals: ["metrics", ...positionals] }, flags, ["metrics", ...positionals]);
  }
  if (subcommand === "self-improve" || subcommand === "improve") {
    return parsePeerSelfImproveCommand(parsed, flags, positionals);
  }
  if (subcommand === "org") {
    return parsePeerOrgCommand(parsed, flags, positionals);
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
  if (subcommand === "init") {
    return parsePeerInitCommand(parsed, flags);
  }
  if (subcommand === "setup") {
    return parsePeerSetupCommand(parsed, flags, positionals);
  }
  return parsed;
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

function parsePeerContextCommand(parsed, flags, positionals) {
  const action = positionals[0];
  if (!action) return parsed;
  const rest = positionals.slice(1);
  const withAction = { ...parsed, contextAction: action };
  if (action === "status") return withAction;
  if (action === "patch") {
    return {
      ...withAction,
      trigger: stringFlag(flags.trigger, undefined),
      change: stringFlag(flags.change, undefined),
      metric: stringFlag(flags.metric, undefined),
      evalName: stringFlag(flags.eval || flags.evalName, undefined),
      owner: stringFlag(flags.owner, undefined),
      reviewDate: stringFlag(flags.reviewDate, undefined),
    };
  }
  if (action === "eval") {
    const patchId = rest[0];
    const status = rest[1];
    if (!patchId || !status) return { ...withAction, error: "/peer context eval requires <patch-id> <pass|fail>" };
    if (!["pass", "fail"].includes(status)) return { ...withAction, patchId, status, error: "/peer context eval status must be pass or fail" };
    return {
      ...withAction,
      patchId,
      status,
      evalName: stringFlag(flags.eval || flags.evalName, undefined),
      evidence: stringFlag(flags.evidence, undefined),
    };
  }
  if (action === "retro") {
    return {
      ...withAction,
      summary: stringFlag(flags.summary, undefined),
      failureType: stringFlag(flags.failure || flags.failureType, undefined),
      runId: stringFlag(flags.run || flags.runId, undefined),
    };
  }
  return { ...withAction, error: `Unknown /peer context action '${action}'` };
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

function parsePeerOrgCommand(parsed, flags, positionals) {
  const action = positionals[0] || "status";
  const rest = positionals.slice(1);
  const withAction = { ...parsed, orgAction: action };
  if (!["init", "status", "role"].includes(action)) return { ...withAction, error: `Unknown /peer org action '${action}'` };
  if (action === "status") return withAction;
  if (action === "init") {
    return {
      ...withAction,
      localPeerId: stringFlag(flags.id || flags.localPeerId, undefined),
      role: stringFlag(flags.role, undefined),
      domain: stringFlag(flags.domain, undefined),
      canSpawnSubagents: flagDefaultEnabled(flags.subagents, true),
    };
  }
  const roleAction = rest[0];
  if (roleAction !== "set") return { ...withAction, roleAction, error: "/peer org role requires set <peer-id> --role <role> [--domain <domain>]" };
  const peerId = rest[1];
  const role = stringFlag(flags.role, undefined);
  const domain = stringFlag(flags.domain, undefined);
  if (!peerId || !role) return { ...withAction, roleAction, peerId, error: "/peer org role set requires <peer-id> --role <role> [--domain <domain>]" };
  return {
    ...withAction,
    roleAction,
    peerId,
    role,
    domain,
    canSpawnSubagents: flags.subagents === undefined ? undefined : flagEnabled(flags.subagents),
  };
}

function parsePeerInitCommand(parsed, flags) {
  const localPeerId = stringFlag(flags.id || flags.localPeerId, undefined);
  const role = stringFlag(flags.role, undefined);
  const domain = stringFlag(flags.domain, undefined);
  const persona = stringFlag(flags.persona, undefined);
  const trust = stringFlag(flags.trust, undefined);
  const capabilities = capabilitiesFromFlags(flags);
  const peer = stringFlag(flags.peer, undefined);
  const peerRole = stringFlag(flags.peerRole, undefined);
  const peerDomain = stringFlag(flags.peerDomain, undefined);
  const peerTrust = stringFlag(flags.peerTrust, undefined);
  const peerCapabilities = capabilitiesFromFlags({ intents: flags.peerIntents });
  const seedPeers = peer ? { [peer]: { ...(peerRole ? { role: peerRole } : {}), ...(peerDomain ? { domain: peerDomain } : {}), ...(peerTrust ? { trust: peerTrust } : {}), ...(Object.keys(peerCapabilities).length ? { capabilities: peerCapabilities } : {}) } } : undefined;
  return stripUndefined({
    ...parsed,
    localPeerId,
    role,
    domain,
    persona,
    trust,
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    seedPeers,
    enabled: !flagEnabled(flags.disabled),
  });
}

function parsePeerSetupCommand(parsed, flags, positionals) {
  if (hasLegacySetupFlags(flags)) return { ...parsePeerInitCommand(parsed, flags), setupWizard: false };
  const action = positionals[0] || "show";
  if (action === "show") return { ...parsed, setupAction: "show", setupWizard: true };
  if (action === "reset" || action === "done") return { ...parsed, setupAction: action, setupWizard: true };
  if (action === "id") {
    const localPeerId = positionals[1];
    if (!localPeerId) return { ...parsed, setupAction: "id", setupWizard: true, error: "/peer setup id requires <peer-id>" };
    return { ...parsed, setupAction: "id", setupWizard: true, localPeerId };
  }
  const setupChoice = setupChoiceFromToken(action);
  if (!setupChoice) return { ...parsed, setupAction: action, setupWizard: true, error: `Unknown /peer setup choice '${action}'` };
  return { ...parsed, setupAction: "choice", setupWizard: true, setupChoice };
}

function parsePeerDoCommand(parsed, flags, positionals) {
  const intent = positionals[0] || "status";
  const validIntents = ["setup", "status", "start", "coordinate", "review", "research", "work", "plan", "verify", "rework", "metrics", "ship", "automate", "resolve-handoffs", "subagents", "mission", "accomplish"];
  const missionAlias = intent === "mission" || intent === "accomplish";
  const missionArgs = missionAlias ? positionals.slice(1) : positionals;
  if (missionAlias || !validIntents.includes(intent)) {
    const objective = missionArgs.join(" ").trim();
    if (!objective) return { ...parsed, intent: "mission", intentArgs: [], error: "/peer do mission requires <objective>" };
    return {
      ...parsed,
      intent: "mission",
      objective,
      intentArgs: missionArgs,
      constraints: listFlag(flags.constraint || flags.constraints),
      paths: listFlag(flags.path || flags.paths),
      gates: listFlag(flags.gate || flags.gates),
      lanes: listFlag(flags.lane || flags.lanes),
    };
  }
  const withIntent = { ...parsed, intent, intentArgs: positionals.slice(1) };
  if (!validIntents.includes(intent)) return { ...withIntent, error: `Unknown /peer do intent '${intent}'` };
  return {
    ...withIntent,
    constraints: listFlag(flags.constraint || flags.constraints),
    paths: listFlag(flags.path || flags.paths),
    gates: listFlag(flags.gate || flags.gates),
    lanes: listFlag(flags.lane || flags.lanes),
  };
}

function parsePeerSpawnCommand(parsed, flags, positionals) {
  const knownActions = new Set(["start", "status", "list", "stop"]);
  const first = positionals[0];
  const spawnAction = knownActions.has(first) ? first : "start";
  const peerTokens = knownActions.has(first) ? positionals.slice(1) : positionals;
  const peerIds = listFlag(flags.peer || flags.peers || peerTokens.join(","));
  return stripUndefined({
    ...parsed,
    spawnAction,
    peerIds,
    count: positiveIntegerFlag(flags.count),
    prefix: stringFlag(flags.prefix, undefined),
    role: stringFlag(flags.role, undefined),
    domain: stringFlag(flags.domain, undefined),
    persona: stringFlag(flags.persona, undefined),
    subagents: flags.subagents === undefined ? undefined : flagEnabled(flags.subagents),
    subagentProvider: stringFlag(flags.subagentProvider || flags.subagentsProvider, undefined),
    command: stringFlag(flags.command || flags.cmd, undefined),
    model: stringFlag(flags.model, undefined),
    providerName: stringFlag(flags.provider, undefined),
    thinking: stringFlag(flags.thinking, undefined),
    includeCurrentExtension: flagEnabled(flags.currentExtension || flags.extension),
    noSession: !flagEnabled(flags.session),
    detached: flagEnabled(flags.detached),
  });
}

function parsePeerSubrunCommand(parsed, flags, positionals) {
  const action = positionals[0] || "status";
  const rest = positionals.slice(1);
  const withAction = { ...parsed, subrunAction: action };
  if (!["status", "start", "progress", "complete", "cancel"].includes(action)) return { ...withAction, error: `Unknown /peer subrun action '${action}'` };
  const common = {
    ...withAction,
    goalId: stringFlag(flags.goal || flags.goalId, undefined),
    mode: stringFlag(flags.mode, undefined),
    provider: stringFlag(flags.provider, undefined),
    workKey: stringFlag(flags.workKey || flags.key, undefined),
    artifactRefs: listFlag(flags.artifact || flags.artifacts || flags.artifactRef || flags.artifactRefs),
    doneCount: nonNegativeIntegerFlag(flags.done || flags.doneCount || flags.completed || flags.completedCount),
    blockedCount: nonNegativeIntegerFlag(flags.blocked || flags.blockedCount),
    childCount: nonNegativeIntegerFlag(flags.child || flags.children || flags.childCount),
  };
  if (action === "status") return stripUndefined(common);
  if (action === "start") {
    const summary = rest.join(" ").trim();
    if (!summary) return { ...common, error: "/peer subrun start requires <summary>" };
    return stripUndefined({ ...common, summary });
  }
  const subrunId = rest[0];
  const summary = rest.slice(1).join(" ").trim();
  if (!subrunId) return { ...common, error: `/peer subrun ${action} requires <subrun-id>${action === "cancel" ? "" : " <summary>"}` };
  if ((action === "progress" || action === "complete") && !summary) return { ...common, subrunId, error: `/peer subrun ${action} requires <subrun-id> <summary>` };
  return stripUndefined({
    ...common,
    subrunId,
    summary: summary || undefined,
    reason: action === "cancel" ? stringFlag(flags.reason, summary || undefined) : undefined,
  });
}

function parsePeerFactoryCommand(parsed, flags, positionals) {
  const action = positionals[0] || "status";
  const rest = positionals.slice(1);
  const withAction = { ...parsed, factoryAction: action };
  const validActions = ["init", "status", "run", "gate", "attempt", "rework", "plan-review", "metrics", "pr", "automate"];
  if (!validActions.includes(action)) return { ...withAction, error: `Unknown /peer factory action '${action}'` };
  if (action === "pr") return parsePeerFactoryPrCommand(withAction, flags, rest);
  if (action === "automate") return parsePeerFactoryAutomateCommand(withAction, flags, rest);
  if (action === "init" || action === "metrics") return withAction;
  if (action === "status") return stripUndefined({ ...withAction, runId: rest[0] });
  if (action === "run") {
    const objective = rest.join(" ").trim();
    if (!objective) return { ...withAction, error: "/peer factory run requires <objective>" };
    return stripUndefined({
      ...withAction,
      objective,
      goalId: stringFlag(flags.goal || flags.goalId, undefined),
      paths: listFlag(flags.path || flags.paths),
      gates: listFlag(flags.gate || flags.gates),
      source: stringFlag(flags.source, undefined),
    });
  }
  if (action === "gate") {
    const runId = rest[0];
    const gateId = rest[1];
    const status = rest[2];
    if (!runId || !gateId || !["pass", "fail", "skip"].includes(status)) return { ...withAction, runId, gateId, status, error: "/peer factory gate requires <run-id> <gate-id> <pass|fail|skip>" };
    return stripUndefined({
      ...withAction,
      runId,
      gateId,
      status,
      evidence: stringFlag(flags.evidence, undefined),
      failureType: stringFlag(flags.failure || flags.failureType, undefined),
    });
  }
  if (action === "attempt") {
    const runId = rest[0];
    const attemptAction = rest[1];
    if (!runId || !["start", "finish"].includes(attemptAction)) return { ...withAction, runId, attemptAction, error: "/peer factory attempt requires <run-id> <start|finish>" };
    return stripUndefined({
      ...withAction,
      runId,
      attemptAction,
      attempt: positiveIntegerFlag(flags.attempt),
      peerId: stringFlag(flags.peer || flags.peerId, undefined),
      summary: stringFlag(flags.summary, undefined),
      status: stringFlag(flags.status, undefined),
      evidence: stringFlag(flags.evidence, undefined),
    });
  }
  if (action === "rework") {
    const runId = rest[0];
    if (!runId) return { ...withAction, error: "/peer factory rework requires <run-id>" };
    return stripUndefined({
      ...withAction,
      runId,
      reason: stringFlag(flags.reason, undefined),
      evidence: stringFlag(flags.evidence, undefined),
      failureType: stringFlag(flags.failure || flags.failureType, undefined),
      owner: stringFlag(flags.owner, undefined),
    });
  }
  const goalId = rest[0];
  if (!goalId) return { ...withAction, error: "/peer factory plan-review requires <goal-id>" };
  return stripUndefined({
    ...withAction,
    goalId,
    paths: listFlag(flags.path || flags.paths),
    gates: listFlag(flags.gate || flags.gates),
    lanes: listFlag(flags.lane || flags.lanes),
  });
}

function parsePeerFactoryAutomateCommand(parsed, flags, positionals) {
  const action = positionals[0];
  const rest = positionals.slice(1);
  const withAction = { ...parsed, automateAction: action };
  if (!action) return { ...withAction, error: "/peer factory automate requires <status|init|run|record>" };
  if (!["status", "init", "run", "record"].includes(action)) return { ...withAction, error: `Unknown /peer factory automate action '${action}'` };
  const flagError = validatePeerFactoryAutomateFlags(parsed, action);
  if (flagError) return { ...withAction, error: flagError };
  if ((action === "status" || action === "init") && rest.length) return { ...withAction, error: `/peer factory automate ${action} accepts no positional arguments` };
  if (action === "status" || action === "init") return withAction;
  if (action === "run") {
    const automationId = rest[0];
    const goalId = stringFlag(flags.goal, undefined);
    if (rest.length > 1) return { ...withAction, automationId, goalId, error: "/peer factory automate run requires exactly <automation-id> --goal <goal-id>" };
    if (!automationId || !goalId) return { ...withAction, automationId, goalId, error: "/peer factory automate run requires <automation-id> --goal <goal-id>" };
    return stripUndefined({
      ...withAction,
      automationId,
      goalId,
      dryRun: flagEnabled(flags.dryRun),
    });
  }
  const automationId = rest[0];
  const status = rest[1];
  const evidence = stringFlag(flags.evidence, undefined);
  if (rest.length > 2) return { ...withAction, automationId, status, evidence, error: "/peer factory automate record requires exactly <automation-id> <done|blocked|error> --evidence <text>" };
  if (!automationId || !["done", "blocked", "error"].includes(status) || !evidence) return { ...withAction, automationId, status, evidence, error: "/peer factory automate record requires <automation-id> <done|blocked|error> --evidence <text>" };
  return stripUndefined({
    ...withAction,
    automationId,
    status,
    evidence,
  });
}

function validatePeerFactoryAutomateFlags(parsed, action) {
  const allowedFlags = {
    status: new Set(),
    init: new Set(),
    run: new Set(["--goal", "--dry-run"]),
    record: new Set(["--evidence"]),
  }[action];
  const unknownFlag = rawPeerFactoryAutomateFlags(parsed).find((flag) => !allowedFlags.has(flag));
  if (!unknownFlag) return undefined;
  if (action === "record") return `Unknown /peer factory automate record flag '${unknownFlag}'`;
  if (action === "status" || action === "init") return `Unknown /peer factory automate ${action} flag '${unknownFlag}'`;
  return `Unknown /peer factory automate flag '${unknownFlag}'`;
}

function rawPeerFactoryAutomateFlags(parsed) {
  const tokens = splitCommandLine(parsed.rawArgs);
  const automateIndex = tokens.indexOf("automate");
  const relevantTokens = automateIndex >= 0 ? tokens.slice(automateIndex + 1) : tokens;
  return relevantTokens
    .filter((token) => token.startsWith("--"))
    .map((token) => token.split("=", 1)[0]);
}

function parsePeerFactoryPrCommand(parsed, flags, positionals) {
  const action = positionals[0] || "status";
  const withAction = { ...parsed, prAction: action };
  if (!["status", "record", "commands"].includes(action)) return { ...withAction, error: `Unknown /peer factory pr action '${action}'` };
  if (action === "status") return withAction;
  if (action === "record") {
    const lifecycleAction = positionals[1];
    const validLifecycleActions = ["created", "ci-failed", "ci-passed", "merged", "post-merge-verified", "stale", "closed"];
    if (!validLifecycleActions.includes(lifecycleAction)) return { ...withAction, action: lifecycleAction, error: "/peer factory pr record requires <created|ci-failed|ci-passed|merged|post-merge-verified|stale|closed>" };
    const runId = stringFlag(flags.run || flags.runId, undefined);
    if (!runId) return { ...withAction, action: lifecycleAction, error: "/peer factory pr record requires --run <run-id>" };
    return stripUndefined({
      ...withAction,
      action: lifecycleAction,
      runId,
      goalId: stringFlag(flags.goal || flags.goalId, undefined),
      prUrl: stringFlag(flags.url || flags.prUrl, undefined),
      evidence: stringFlag(flags.evidence, undefined),
    });
  }
  const title = stringFlag(flags.title, undefined);
  const body = stringFlag(flags.body, undefined);
  if (!title || !body) return { ...withAction, error: "/peer factory pr commands requires --title <title> --body <body>" };
  return stripUndefined({
    ...withAction,
    title,
    body,
    branch: rawStringFlag(flags.branch, undefined),
    remote: rawStringFlag(flags.remote, undefined),
  });
}

function parsePeerGoalCommand(parsed, flags, positionals) {
  const action = positionals[0] || "list";
  const rest = positionals.slice(1);
  const withAction = { ...parsed, goalAction: action };
  if (action === "list") return withAction;
  if (action === "create") {
    const objective = rest.join(" ").trim();
    if (!objective) return { ...withAction, error: "/peer goal create requires <objective>" };
    return { ...withAction, objective, constraints: listFlag(flags.constraint || flags.constraints), closurePolicy: closurePolicyFromFlags(flags) };
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
      duplicatePolicy: flagEnabled(flags.allowParallel) ? "allow-parallel" : stringFlag(flags.duplicatePolicy, undefined),
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

function closurePolicyFromFlags(flags = {}) {
  const minPassingVotes = positiveIntegerFlag(firstDefined(flags.minPassingVotes, flags.minVotes));
  const minIndependentVotes = positiveIntegerFlag(firstDefined(flags.minIndependentVotes, flags.minIndependentPassingVotes, flags.independentVotes));
  const closurePolicy = {
    ...(minPassingVotes ? { minPassingVotes } : {}),
    ...(minIndependentVotes ? { minIndependentVotes } : {}),
  };
  return Object.keys(closurePolicy).length ? closurePolicy : undefined;
}

function stringFlag(value, fallback) {
  if (Array.isArray(value)) return stringFlag(value.at(-1), fallback);
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function rawStringFlag(value, fallback) {
  if (Array.isArray(value)) return rawStringFlag(value.at(-1), fallback);
  if (typeof value === "string" && value.length) return value;
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

function nonNegativeIntegerFlag(value) {
  if (Array.isArray(value)) return nonNegativeIntegerFlag(value.at(-1));
  if (value === undefined || value === true) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
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

function hasLegacySetupFlags(flags = {}) {
  const legacyFlags = [
    "id",
    "localPeerId",
    "role",
    "domain",
    "persona",
    "trust",
    "peer",
    "peerRole",
    "peerDomain",
    "peerTrust",
    "peerIntents",
    "disabled",
    "intents",
    "write",
    "writeAccess",
    "readOnly",
    "subagents",
    "subagentProvider",
    "subagentsProvider",
    "subagentMode",
    "subagentModes",
    "subagentMaxDepth",
    "maxSubagentDepth",
    "subagentConcurrency",
    "maxSubagentConcurrency",
    "noSubagentWorktree",
    "subagentIntercom",
  ];
  return legacyFlags.some((flag) => flags[flag] !== undefined);
}

function setupChoiceFromToken(token) {
  const choices = {
    "1": "coordinate",
    coordinator: "coordinate",
    planner: "coordinate",
    coordinate: "coordinate",
    "2": "implement",
    implement: "implement",
    implementation: "implement",
    code: "implement",
    worker: "implement",
    "3": "review",
    review: "review",
    reviewer: "review",
    "4": "research",
    research: "research",
    researcher: "research",
    "5": "subagents",
    subagent: "subagents",
    subagents: "subagents",
    "6": "status",
    status: "status",
    inspect: "status",
  };
  return choices[token];
}

function capabilitiesFromFlags(flags = {}) {
  const capabilities = {};
  const intents = listFlag(flags.intents);
  if (intents.length) capabilities.intents = intents;
  if (flagEnabled(flags.write) || flagEnabled(flags.writeAccess)) capabilities.writeAccess = true;
  if (flagEnabled(flags.readOnly)) capabilities.writeAccess = false;
  if (flagEnabled(flags.subagents)) {
    const modes = listFlag(flags.subagentMode || flags.subagentModes);
    capabilities.orchestration = {
      subagents: true,
      provider: stringFlag(flags.subagentProvider || flags.subagentsProvider, "pi-subagents"),
      modes: modes.length ? modes : ["single", "parallel", "chain", "async"],
      maxDepth: positiveIntegerFlag(flags.subagentMaxDepth || flags.maxSubagentDepth) || 1,
      maxConcurrency: positiveIntegerFlag(flags.subagentConcurrency || flags.maxSubagentConcurrency) || 4,
      worktree: !flagEnabled(flags.noSubagentWorktree),
      intercom: flagEnabled(flags.subagentIntercom),
    };
  }
  return capabilities;
}

function listFlag(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((item) => {
    if (typeof item !== "string") return [];
    return item.split(",").map((part) => part.trim()).filter(Boolean);
  }))];
}
