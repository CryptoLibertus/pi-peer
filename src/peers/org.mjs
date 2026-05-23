import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

export const PEER_ORG_RELATIVE_PATH = ".pi/peer-org.json";
export const PEER_ORG_VERSION = 1;
export const PEER_ORG_INIT_ID_ERROR = "/peer org init requires --id <peer-id> or an existing stable peer identity from .pi/peers.json or PI_PEER_ID";

export const DEFAULT_PEER_ORG_ROLES = Object.freeze({
  coordinator: {
    domain: "coordination",
    manager: true,
    canSpawnSubagents: true,
    defaultLanes: ["coordination", "research", "review"],
    expectedEvidence: ["decision-log", "handoff", "open-risks"],
    countsForIndependentVote: true,
  },
  planner: {
    domain: "planning",
    manager: true,
    canSpawnSubagents: true,
    defaultLanes: ["coordination", "research"],
    expectedEvidence: ["plan", "constraints", "handoff"],
    countsForIndependentVote: true,
  },
  researcher: {
    domain: "research",
    manager: true,
    canSpawnSubagents: true,
    defaultLanes: ["research"],
    expectedEvidence: ["citations", "fact-checks", "limitations"],
    countsForIndependentVote: true,
  },
  implementer: {
    domain: "implementation",
    manager: true,
    canSpawnSubagents: true,
    defaultLanes: ["implementation"],
    expectedEvidence: ["files-changed", "verification", "blockers-risks"],
    countsForIndependentVote: false,
  },
  worker: {
    domain: "implementation",
    manager: true,
    canSpawnSubagents: true,
    defaultLanes: ["implementation"],
    expectedEvidence: ["files-changed", "verification", "blockers-risks"],
    countsForIndependentVote: false,
  },
  reviewer: {
    domain: "review",
    manager: true,
    canSpawnSubagents: true,
    defaultLanes: ["review", "qa"],
    expectedEvidence: ["findings", "verification", "residual-risk"],
    countsForIndependentVote: true,
  },
});

const DEFAULT_PEER_ORG_MODEL = "peer-private-subagent-teams";

export function peerOrgPath(root) {
  if (!root) throw new Error("peer org requires root");
  return resolvePath(root, PEER_ORG_RELATIVE_PATH);
}

export async function initPeerOrg(root, input = {}) {
  const path = peerOrgPath(root);
  const relativePath = PEER_ORG_RELATIVE_PATH;
  const org = normalizePeerOrg(input);
  await mkdir(dirname(path), { recursive: true });

  let handle;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(`${JSON.stringify(org, null, 2)}\n`, "utf8");
    return { ok: true, created: true, existed: false, path, relativePath, org, warnings: [] };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const loaded = await loadPeerOrg(root);
    return { ok: true, created: false, existed: true, path, relativePath, org: loaded.org, warnings: loaded.warnings };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function loadPeerOrg(root, options = {}) {
  const path = peerOrgPath(root);
  const relativePath = PEER_ORG_RELATIVE_PATH;
  let parsed;

  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && options.allowMissing) {
      return { exists: false, path, relativePath, org: normalizePeerOrg({}), warnings: [] };
    }
    throw error;
  }

  const warnings = [];
  if (parsed?.version !== undefined && parsed.version !== PEER_ORG_VERSION) {
    warnings.push(`peer org version ${parsed.version} normalized to ${PEER_ORG_VERSION}`);
  }
  return { exists: true, path, relativePath, org: normalizePeerOrg(parsed), warnings };
}

export async function setPeerOrgRole(root, peerId, input = {}) {
  const normalizedPeerId = cleanKey(peerId);
  if (!normalizedPeerId) throw new Error("peer org role requires peerId");

  const loaded = await loadPeerOrg(root, { allowMissing: true });
  const org = normalizePeerOrg(loaded.org);
  org.peers[normalizedPeerId] = normalizePeerOrgPeer(input, org.roles);

  const path = peerOrgPath(root);
  const relativePath = PEER_ORG_RELATIVE_PATH;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(org, null, 2)}\n`, "utf8");

  return { ok: true, created: !loaded.exists, path, relativePath, peerId: normalizedPeerId, org, warnings: loaded.warnings || [] };
}

export function resolvePeerOrgInitPeerId(parsed = {}, runtime = {}) {
  const explicitPeerId = cleanText(parsed.localPeerId);
  if (explicitPeerId) return explicitPeerId;

  const source = cleanText(runtime?.summary?.localPeerIdSource || runtime?.config?.localPeerIdSource);
  if (!source || source.toLowerCase() === "generated") throw new Error(PEER_ORG_INIT_ID_ERROR);

  const peerId = cleanText(runtime?.localPeerId || runtime?.summary?.localPeerId);
  if (peerId) return peerId;
  throw new Error(PEER_ORG_INIT_ID_ERROR);
}

export function normalizePeerOrg(input = {}) {
  const source = plainObject(input) ? input : {};
  const roles = normalizePeerOrgRoles(source.roles);

  return {
    version: PEER_ORG_VERSION,
    model: cleanText(source.model) || DEFAULT_PEER_ORG_MODEL,
    roles,
    peers: normalizePeerOrgPeers(source.peers, roles),
    spawnPolicy: normalizePeerOrgSpawnPolicy(source.spawnPolicy),
    evidence: normalizePeerOrgEvidence(source.evidence),
  };
}

export function normalizePeerOrgPeer(input = {}, roles = DEFAULT_PEER_ORG_ROLES) {
  const source = plainObject(input) ? input : {};
  const normalizedRoles = plainObject(roles) ? roles : DEFAULT_PEER_ORG_ROLES;
  const role = cleanKey(source.role) || "worker";
  const roleDefinition = plainObject(normalizedRoles[role]) ? normalizedRoles[role] : {};
  const defaultLanes = normalizeUniqueList(source.defaultLanes ?? source.lanes);
  const expectedEvidence = normalizeUniqueList(source.expectedEvidence ?? source.evidence);

  return {
    role,
    domain: cleanKey(source.domain) || cleanKey(roleDefinition.domain) || role,
    manager: normalizeBoolean(source.manager, roleDefinition.manager !== false),
    canSpawnSubagents: normalizeBoolean(source.canSpawnSubagents ?? source.subagents, roleDefinition.canSpawnSubagents !== false),
    defaultLanes: defaultLanes.length ? defaultLanes : normalizeUniqueList(roleDefinition.defaultLanes),
    expectedEvidence: expectedEvidence.length ? expectedEvidence : normalizeUniqueList(roleDefinition.expectedEvidence),
    countsForIndependentVote: normalizeBoolean(source.countsForIndependentVote ?? source.independentVote, roleDefinition.countsForIndependentVote === true),
  };
}

export function formatPeerOrgInitResult(result = {}) {
  const lines = [
    result.created ? "Peer org: initialized" : result.existed ? "Peer org: already initialized" : result.ok ? "Peer org: ok" : "Peer org: not initialized",
    `path: ${result.relativePath || result.path || PEER_ORG_RELATIVE_PATH}`,
  ];
  if (result.org?.model) lines.push(`model: ${result.org.model}`);
  for (const warning of result.warnings || []) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

export function formatPeerOrgStatus(input = {}) {
  const org = normalizePeerOrg(input.org || {});
  const lines = [
    `Peer org: ${input.exists ? "configured" : "not initialized"}`,
    `model: ${org.model}`,
    `spawn: ${org.spawnPolicy.enabled ? "enabled" : "disabled"} · provider ${org.spawnPolicy.provider} · maxDepth ${org.spawnPolicy.maxDepth} · maxConcurrency ${org.spawnPolicy.maxConcurrency} · private teams ${yesNo(org.spawnPolicy.privateTeams)}`,
    `evidence: ledger ${org.evidence.ledgerKind} · handoff subagent evidence ${yesNo(org.evidence.attachSubagentEvidenceToHandoff)}`,
    "",
    "Peers:",
  ];

  const entries = Object.entries(org.peers);
  if (!entries.length) {
    lines.push("- none");
    return lines.join("\n");
  }

  for (const [peerId, peer] of entries) {
    lines.push(`- ${peerId} · role ${peer.role} · domain ${peer.domain} · manager ${yesNo(peer.manager)} · subagents ${yesNo(peer.canSpawnSubagents)}`);
  }
  return lines.join("\n");
}

function normalizePeerOrgRoles(input = {}) {
  const roles = {};
  for (const [roleName, role] of Object.entries(clonePlain(DEFAULT_PEER_ORG_ROLES))) {
    roles[roleName] = normalizePeerOrgRole(roleName, role, role);
  }

  if (!plainObject(input)) return roles;
  for (const [rawRoleName, role] of Object.entries(input)) {
    const roleName = cleanKey(rawRoleName);
    if (!roleName) continue;
    roles[roleName] = normalizePeerOrgRole(roleName, role, roles[roleName]);
  }
  return roles;
}

function normalizePeerOrgRole(roleName, input = {}, fallback = {}) {
  const source = plainObject(input) ? input : {};
  const base = plainObject(fallback) ? fallback : {};
  const defaultLanes = normalizeUniqueList(source.defaultLanes);
  const expectedEvidence = normalizeUniqueList(source.expectedEvidence);

  return {
    domain: cleanKey(source.domain) || cleanKey(base.domain) || roleName,
    manager: normalizeBoolean(source.manager, base.manager !== false),
    canSpawnSubagents: normalizeBoolean(source.canSpawnSubagents, base.canSpawnSubagents !== false),
    defaultLanes: defaultLanes.length ? defaultLanes : normalizeUniqueList(base.defaultLanes),
    expectedEvidence: expectedEvidence.length ? expectedEvidence : normalizeUniqueList(base.expectedEvidence),
    countsForIndependentVote: normalizeBoolean(source.countsForIndependentVote, base.countsForIndependentVote === true),
  };
}

function normalizePeerOrgPeers(input = {}, roles = DEFAULT_PEER_ORG_ROLES) {
  if (!plainObject(input)) return {};
  const peers = {};
  for (const [rawPeerId, peer] of Object.entries(input)) {
    const peerId = cleanKey(rawPeerId);
    if (!peerId) continue;
    peers[peerId] = normalizePeerOrgPeer(peer, roles);
  }
  return peers;
}

function normalizePeerOrgSpawnPolicy(input = {}) {
  const source = plainObject(input) ? input : {};
  return {
    enabled: normalizeBoolean(source.enabled, true),
    provider: cleanKey(source.provider) || "optional",
    maxDepth: normalizeNonNegativeInteger(source.maxDepth, 1),
    maxConcurrency: normalizePositiveInteger(source.maxConcurrency, 4),
    privateTeams: normalizeBoolean(source.privateTeams, true),
    childClaimsTopLevel: normalizeBoolean(source.childClaimsTopLevel, false),
    childVotesIndependent: normalizeBoolean(source.childVotesIndependent, false),
  };
}

function normalizePeerOrgEvidence(input = {}) {
  const source = plainObject(input) ? input : {};
  return {
    attachSubagentEvidenceToHandoff: normalizeBoolean(source.attachSubagentEvidenceToHandoff, true),
    ledgerKind: cleanKey(source.ledgerKind) || "subrun",
    fullTranscriptStorage: cleanKey(source.fullTranscriptStorage) || "provider-artifact",
  };
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function cleanKey(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, "-");
}

function normalizeList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(cleanText).filter(Boolean))];
  if (typeof value === "string") return value.split(",").map(cleanText).filter(Boolean);
  return [];
}

function normalizeUniqueList(value) {
  return [...new Set(normalizeList(value))];
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
