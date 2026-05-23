export function buildPeerCommandCenterState(input = {}) {
  const runtimeStatus = input.runtimeStatus || {};
  const orgState = input.orgState || {};
  const orgData = normalizeOrgData(orgState);
  const setup = input.setup || {};
  const controlState = input.controlState || {};
  const peers = Array.isArray(runtimeStatus.peers) ? runtimeStatus.peers : [];
  const activePeers = peers.filter((peer) => peer.status === "active");
  const localPeerId = runtimeStatus.localPeerId || "unknown";
  const goals = Array.isArray(input.goals) ? input.goals : [];
  const currentGoal = selectCurrentGoal(input.currentGoal, goals);

  const state = {
    enabled: runtimeStatus.enabled === true,
    local: {
      peerId: localPeerId,
      role: text(runtimeStatus.localRole || runtimeStatus.localProfile?.role || runtimeStatus.role, "unknown"),
      domain: text(runtimeStatus.localDomain || runtimeStatus.localProfile?.domain || runtimeStatus.domain, "unknown"),
      canSpawnSubagents: localCanSpawnSubagents(localPeerId, orgData, runtimeStatus),
    },
    peers: {
      active: activePeers.map((peer) => ({
        peerId: text(peer.peerId, "unknown"),
        role: text(peer.role, "unknown"),
        domain: text(peer.domain, "unknown"),
      })),
      byRole: groupActivePeers(activePeers),
    },
    org: {
      exists: orgState.exists === true,
      spawnPolicy: {
        enabled: orgData.spawnPolicy?.enabled === true,
        provider: text(orgData.spawnPolicy?.provider, "unknown"),
        privateTeams: orgData.spawnPolicy?.privateTeams === true,
      },
    },
    setup: {
      exists: setup.exists === true || orgState.exists === true || runtimeStatus.enabled === true,
    },
    goals,
    currentGoal,
    control: {
      activeTasks: array(controlState.activeTasks),
      disconnectedTasks: array(controlState.disconnectedTasks),
      activeSubruns: array(controlState.activeSubruns),
      completedSubruns: array(controlState.completedSubruns),
    },
    objective: input.objective || currentGoal?.objective || "new peer goal",
  };
  state.recommendations = derivePeerCommandCenterRecommendations(state);
  return state;
}

export function derivePeerCommandCenterRecommendations(state = {}) {
  const goal = state.currentGoal || selectCurrentGoal(undefined, array(state.goals));
  const commands = [];
  const control = state.control || {};

  if (array(control.disconnectedTasks).length) commands.push(recommend("/peer reconnect", "resume disconnected peer tasks"));
  if (goal && array(goal.staleClaims).length) commands.push(recommend(`/peer do coordinate ${goal.id}`, "coordinate stale claims"));
  if (goal && array(goal.unresolvedTaskHandoffs).length) commands.push(recommend("/peer do resolve-handoffs", "resolve peer handoffs"));
  if (goal && array(goal.blockingObjections).length) commands.push(recommend(`/peer do coordinate ${goal.id}`, "clear blockers"));
  if (goal && shouldRecommendReview(goal)) commands.push(recommend(`/peer do review ${goal.id}`, "collect current review"));
  if (array(control.activeSubruns).length) commands.push(recommend("/peer subrun status", "check active subruns"));
  if (state.setup?.exists === false) commands.push(recommend("/peer setup", "configure peer command center"));
  if (!goal) commands.push(recommend(`/peer do start goal "${state.objective || "new peer goal"}"`, "start a peer goal"));

  return dedupeRecommendations(commands);
}

export function formatPeerCommandCenter(state = {}) {
  const recommendations = dedupeRecommendations(array(state.recommendations).length ? state.recommendations : derivePeerCommandCenterRecommendations(state));
  const currentGoal = state.currentGoal || selectCurrentGoal(undefined, array(state.goals));
  const lines = [
    "Peer command center",
    `Local: ${state.local?.peerId || "unknown"} · role ${state.local?.role || "unknown"} · domain ${state.local?.domain || "unknown"} · subagents ${state.local?.canSpawnSubagents ? "yes" : "no"}`,
    formatOrgLine(state.org),
    `Peers: ${array(state.peers?.active).length} active`,
  ];

  for (const group of array(state.peers?.byRole)) {
    const roleIds = group.peers.slice(0, 3).map((peer) => peer.peerId).join(", ");
    const extra = group.peers.length > 3 ? ` +${group.peers.length - 3}` : "";
    lines.push(`- ${group.role}: ${roleIds || "none"}${extra}`);
    for (const domain of group.domains) lines.push(`  ${domain.domain}: ${domain.peers.map((peer) => peer.peerId).join(", ")}`);
  }

  lines.push(formatGoalLine(currentGoal, state.control));
  lines.push("Recommended:");
  if (recommendations.length) {
    recommendations.forEach((item, index) => lines.push(`${index + 1}. ${item.command}${item.reason ? ` — ${item.reason}` : ""}`));
  } else {
    lines.push("1. /peer status");
  }
  return lines.join("\n");
}

export function formatPeerIntentResult(result = {}) {
  if (typeof result.text === "string" && result.text.trim()) return result.text.trim();
  const commands = array(result.commands).map((item) => typeof item === "string" ? item : item?.command).filter(Boolean);
  if (commands.length) return commands.map((command, index) => `${index + 1}. ${command}`).join("\n");
  if (typeof result.command === "string") return result.command;
  return "";
}

function groupActivePeers(activePeers) {
  const roles = new Map();
  for (const peer of activePeers) {
    const normalized = {
      peerId: text(peer.peerId, "unknown"),
      role: text(peer.role, "unknown"),
      domain: text(peer.domain, "unknown"),
    };
    if (!roles.has(normalized.role)) roles.set(normalized.role, { role: normalized.role, peers: [], domainMap: new Map() });
    const roleGroup = roles.get(normalized.role);
    roleGroup.peers.push(normalized);
    if (!roleGroup.domainMap.has(normalized.domain)) roleGroup.domainMap.set(normalized.domain, []);
    roleGroup.domainMap.get(normalized.domain).push(normalized);
  }
  return [...roles.values()]
    .sort((a, b) => a.role.localeCompare(b.role))
    .map((group) => ({
      role: group.role,
      peers: group.peers.sort(comparePeerId),
      domains: [...group.domainMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([domain, peers]) => ({ domain, peers: peers.sort(comparePeerId) })),
    }));
}

function selectCurrentGoal(currentGoal, goals) {
  if (currentGoal) return currentGoal;
  const openGoals = array(goals).filter((goal) => goal?.status !== "closed");
  return openGoals.find((goal) => array(goal.blockingObjections).length || array(goal.unresolvedTaskHandoffs).length) || openGoals[0];
}

function normalizeOrgData(orgState = {}) {
  const nested = orgState.org && typeof orgState.org === "object" ? orgState.org : {};
  return {
    peers: nested.peers || orgState.peers,
    spawnPolicy: nested.spawnPolicy || orgState.spawnPolicy,
  };
}

function localCanSpawnSubagents(localPeerId, orgData, runtimeStatus) {
  const orgPeer = orgPeerConfig(orgData, localPeerId);
  if (orgPeer && typeof orgPeer.canSpawnSubagents === "boolean") return orgPeer.canSpawnSubagents;
  return runtimeStatus.localCapabilities?.orchestration?.subagents === true;
}

function orgPeerConfig(orgData = {}, localPeerId) {
  const peers = orgData.peers;
  if (Array.isArray(peers)) return peers.find((peer) => peer.peerId === localPeerId || peer.id === localPeerId);
  if (peers && typeof peers === "object") return peers[localPeerId];
  return undefined;
}

function shouldRecommendReview(goal = {}) {
  const votes = array(goal.currentVotes);
  if (votes.length === 0) return true;
  return !votes.some((vote) => vote.verdict === "pass" || vote.verdict === "pass-with-risks");
}

function formatOrgLine(org = {}) {
  if (!org.exists) return "Org: not configured";
  const privateTeams = org.spawnPolicy?.privateTeams ? "private teams enabled" : "private teams disabled";
  return `Org: configured · ${privateTeams} · provider ${org.spawnPolicy?.provider || "unknown"}`;
}

function formatGoalLine(goal, control = {}) {
  if (!goal) return "Goals: none";
  const activeTasks = array(goal.activeTasks).length || array(control.activeTasks).length;
  const subruns = array(control.activeSubruns).length;
  return `Goals: ${goal.id || "unknown"} ready ${goal.readyToClose ? "yes" : "no"} · blockers ${array(goal.blockingObjections).length} · active tasks ${activeTasks} · subruns ${subruns}`;
}

function recommend(command, reason) {
  return { command, reason };
}

function dedupeRecommendations(recommendations) {
  const seen = new Set();
  const deduped = [];
  for (const item of recommendations) {
    const command = typeof item === "string" ? item : item?.command;
    if (!command || seen.has(command)) continue;
    seen.add(command);
    deduped.push(typeof item === "string" ? { command } : item);
  }
  return deduped;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function comparePeerId(a, b) {
  return a.peerId.localeCompare(b.peerId);
}
