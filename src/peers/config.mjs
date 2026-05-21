import { mkdir, open, readFile as defaultReadFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { normalizePeerDescriptor } from "./comms.mjs";
import { normalizePeerIdleWatcherConfig } from "./idle-watcher.mjs";
import { PEER_VERSION, peerProtocolMetadata, redactPeerAuditValue } from "./protocol.mjs";

export const PEER_SETTINGS_RELATIVE_PATH = ".pi/settings.json";
export const PEER_CONFIG_RELATIVE_PATH = ".pi/peers.json";
export const PI_PEER_ID_ENV = "PI_PEER_ID";
export const SUPPORTED_PEER_TRANSPORTS = Object.freeze(["coms"]);
export const DEFAULT_AGENT_MD_MAX_BYTES = 24 * 1024;

const SUPPORTED_PEER_TRANSPORT_SET = new Set(SUPPORTED_PEER_TRANSPORTS);

export async function loadPeerRuntimeConfig(cwd, options = {}) {
  const readFile = options.readFile || defaultReadFile;
  const [settings, peerFile] = await Promise.all([
    readJsonMaybe(resolve(cwd, PEER_SETTINGS_RELATIVE_PATH), readFile),
    readJsonMaybe(resolve(cwd, PEER_CONFIG_RELATIVE_PATH), readFile),
  ]);
  return parsePeerRuntimeConfig({ settings, peerFile, env: options.env || process.env });
}

export function parsePeerRuntimeConfig({ settings, peerFile, env } = {}) {
  const hasSettings = isPlainObject(settings);
  const hasPeerFile = isPlainObject(peerFile);
  const warnings = [];
  const enabled = settingsEnabled(settings) || peerFile?.enabled === true;
  const peersById = new Map();

  for (const peer of configuredPeers(settings?.peers, "settings", warnings)) peersById.set(peer.peerId, peer);
  for (const peer of configuredPeers(peerFile?.peers, "peers", warnings)) peersById.set(peer.peerId, { ...(peersById.get(peer.peerId) || {}), ...peer });

  const manifest = normalizePeerManifest(peerFile?.manifest || settings?.peerMessaging?.manifest || settings?.manifest);
  const idleWatcher = normalizePeerIdleWatcherConfig(peerFile?.idleWatcher || settings?.peerMessaging?.idleWatcher || settings?.idleWatcher, { env });
  const peers = [...peersById.values()].map((peer) => markUnsupportedTransport(normalizePeerDescriptor({ ...manifestDefaults(manifest), ...peer }), warnings));
  const peerFileLocalPeerId = normalizePeerId(peerFile?.localPeerId);
  const settingsPeerMessagingLocalPeerId = normalizePeerId(settings?.peerMessaging?.localPeerId);
  const settingsLocalPeerId = normalizePeerId(settings?.localPeerId);
  const localPeerId = peerFileLocalPeerId || settingsPeerMessagingLocalPeerId || settingsLocalPeerId;
  const config = {
    enabled,
    source: configSource(hasSettings, hasPeerFile),
    manifest,
    idleWatcher,
    localPeerId,
    localPeerIdSource: localPeerIdSource({ peerFileLocalPeerId, settingsPeerMessagingLocalPeerId, settingsLocalPeerId }),
    peers,
    warnings: unique(warnings),
  };
  return applyLocalPeerIdOverride(config, { env });
}

export function applyLocalPeerIdOverride(config = {}, options = {}) {
  const explicitLocalPeerId = normalizePeerId(options.localPeerId);
  if (explicitLocalPeerId) return { ...config, localPeerId: explicitLocalPeerId, localPeerIdSource: "options.localPeerId" };

  const envLocalPeerId = normalizePeerId(options.env?.[PI_PEER_ID_ENV]);
  if (envLocalPeerId) return { ...config, localPeerId: envLocalPeerId, localPeerIdSource: PI_PEER_ID_ENV };

  const localPeerId = normalizePeerId(config.localPeerId);
  return { ...config, localPeerId, localPeerIdSource: localPeerId ? config.localPeerIdSource : undefined };
}

export async function initPeerConfig(cwd, options = {}) {
  const relativePath = options.relativePath || PEER_CONFIG_RELATIVE_PATH;
  const path = resolve(cwd, relativePath);
  const config = buildDefaultPeerConfig(options);
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { ok: true, created: true, existed: false, path, relativePath, config };
  } catch (error) {
    if (error?.code === "EEXIST") return { ok: true, created: false, existed: true, path, relativePath };
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function buildDefaultPeerConfig(options = {}) {
  return {
    enabled: options.enabled !== false,
    localPeerId: normalizePeerId(options.localPeerId) || defaultLocalPeerId(),
    manifest: normalizePeerManifest({
      trust: options.trust || "conversation",
      capabilities: options.capabilities || { intents: ["ask", "review", "notify", "coordinate", "task"] },
      protocolVersion: PEER_VERSION,
    }),
    peers: buildDefaultPeerEntries(options),
  };
}

export function summarizePeerRuntimeConfig(config) {
  return {
    enabled: config.enabled === true,
    source: config.source || "none",
    localPeerId: config.localPeerId,
    localPeerIdSource: config.localPeerIdSource,
    localPeerProfile: summarizePeerProfile(config.localPeerProfile),
    protocolVersion: config.manifest?.protocolVersion || PEER_VERSION,
    manifest: summarizePeerManifest(config.manifest),
    idleWatcher: summarizePeerIdleWatcher(config.idleWatcher),
    peerCount: Array.isArray(config.peers) ? config.peers.length : 0,
    peers: (config.peers || []).map((peer) => ({
      peerId: peer.peerId,
      transport: peer.transport,
      trust: peer.trust,
      status: peer.status,
      maxHopCount: peer.maxHopCount,
      protocolVersion: peer.protocolVersion,
      compatible: peer.compatible,
      capabilities: peer.capabilities || {},
      ...summarizePeerProfile(peer),
      ...(peer.unsupportedReason ? { unsupportedReason: peer.unsupportedReason } : {}),
    })),
    warnings: [...(config.warnings || [])],
  };
}

export function normalizePeerGoalClosurePolicy(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const policy = {};
  const minPassingVotes = positiveInteger(source.minPassingVotes ?? source.minVotes);
  if (minPassingVotes !== undefined) policy.minPassingVotes = minPassingVotes;

  const requiredVotes = normalizeClosureRequirements(source.requiredVotes || source.votes, { defaultTypes: ["vote"] });
  if (requiredVotes.length) policy.requiredVotes = requiredVotes;

  const requiredEvidence = normalizeClosureRequirements(source.requiredEvidence || source.evidence, { defaultTypes: ["finding", "handoff"] });
  if (requiredEvidence.length) policy.requiredEvidence = requiredEvidence;

  return Object.keys(policy).length ? policy : undefined;
}

function normalizeClosureRequirements(input, options = {}) {
  const items = Array.isArray(input) ? input : [];
  return items
    .map((item) => normalizeClosureRequirement(item, options))
    .filter(Boolean);
}

function normalizeClosureRequirement(input = {}, options = {}) {
  if (!isPlainObject(input)) return undefined;
  const requirement = {};
  const types = normalizeStringList(input.types || input.type || options.defaultTypes).map((item) => item.toLowerCase());
  if (types.length) requirement.types = types;
  const verdicts = normalizeStringList(input.verdicts || input.verdict).map((item) => item.toLowerCase());
  if (verdicts.length) requirement.verdicts = verdicts;
  const lane = normalizedString(input.lane || input.workLane)?.toLowerCase();
  if (lane) requirement.lane = lane;
  const role = normalizedString(input.role)?.toLowerCase();
  if (role) requirement.role = role;
  const peerId = normalizedString(input.peerId);
  if (peerId) requirement.peerId = peerId;
  const workKey = normalizedString(input.workKey)?.toLowerCase().replace(/\s+/g, " ");
  if (workKey) requirement.workKey = workKey;
  const status = normalizedString(input.status)?.toLowerCase();
  if (status) requirement.status = status;
  requirement.min = positiveInteger(input.min) || 1;
  return requirement;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => normalizedString(item)).filter(Boolean);
  const text = normalizedString(value);
  return text ? [text] : [];
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export async function loadLocalPeerProfile(cwd, config = {}, options = {}) {
  const readFile = options.readFile || defaultReadFile;
  const profile = deriveLocalPeerProfile(config, options);
  const warnings = [];
  if (!profile.agentMd) return { profile, warnings };

  const resolved = resolveProjectRelativeFile(cwd, profile.agentMd);
  if (!resolved.ok) {
    warnings.push(`${profile.peerId || "local peer"} agentMd ignored: ${resolved.reason}`);
    return { profile, warnings };
  }

  try {
    const content = await readFile(resolved.path, "utf8");
    return {
      profile: {
        ...profile,
        agentMdPath: profile.agentMd,
        agentMdContent: content.slice(0, Number.isInteger(options.maxAgentMdBytes) ? options.maxAgentMdBytes : DEFAULT_AGENT_MD_MAX_BYTES),
      },
      warnings,
    };
  } catch (error) {
    if (error?.code === "ENOENT") warnings.push(`${profile.peerId || "local peer"} agentMd ignored: ${profile.agentMd} was not found`);
    else warnings.push(`${profile.peerId || "local peer"} agentMd ignored: ${error.message}`);
    return { profile, warnings };
  }
}

export function deriveLocalPeerProfile(config = {}, options = {}) {
  const localPeerId = normalizePeerId(options.localPeerId) || normalizePeerId(config.localPeerId) || config.localPeerId;
  const configured = findConfiguredLocalPeer(config.peers, localPeerId);
  return normalizePeerProfile({ peerId: localPeerId, ...(configured || {}), ...explicitPeerProfileOptions(options) });
}

export function summarizePeerProfile(profile = {}) {
  const summary = {};
  for (const field of ["role", "persona"]) {
    const value = safeSummaryString(profile[field]);
    if (value) summary[field] = value;
  }
  return Object.keys(summary).length ? summary : undefined;
}

function summarizePeerIdleWatcher(idleWatcher = {}) {
  return {
    enabled: idleWatcher.enabled !== false,
    intervalMs: idleWatcher.intervalMs,
    cooldownMs: idleWatcher.cooldownMs,
    maxActivationsPerSession: idleWatcher.maxActivationsPerSession,
  };
}

function defaultLocalPeerId() {
  return `pi-${sanitizePeerId(hostname()) || "local"}`;
}

export function normalizePeerId(value) {
  return typeof value === "string" && value.trim() ? sanitizePeerId(value) : undefined;
}

function localPeerIdSource({ peerFileLocalPeerId, settingsPeerMessagingLocalPeerId, settingsLocalPeerId }) {
  if (peerFileLocalPeerId) return `${PEER_CONFIG_RELATIVE_PATH}:localPeerId`;
  if (settingsPeerMessagingLocalPeerId) return `${PEER_SETTINGS_RELATIVE_PATH}:peerMessaging.localPeerId`;
  if (settingsLocalPeerId) return `${PEER_SETTINGS_RELATIVE_PATH}:localPeerId`;
  return undefined;
}

function sanitizePeerId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function findConfiguredLocalPeer(peers, localPeerId) {
  if (!Array.isArray(peers) || !localPeerId) return undefined;
  return peers.find((peer) => peer.peerId === localPeerId || normalizePeerId(peer.peerId) === localPeerId);
}

function explicitPeerProfileOptions(options = {}) {
  const profile = {};
  for (const field of ["role", "persona", "agentMd", "agentInstructions"]) {
    const value = normalizedString(options[field]);
    if (value) profile[field] = value;
  }
  return profile;
}

function normalizePeerProfile(source = {}) {
  const profile = {};
  const peerId = normalizedString(source.peerId);
  if (peerId) profile.peerId = peerId;
  for (const field of ["role", "persona", "agentMd", "agentInstructions", "agentMdPath", "agentMdContent"]) {
    const value = normalizedString(source[field]);
    if (value) profile[field] = value;
  }
  return profile;
}

function resolveProjectRelativeFile(cwd, configuredPath) {
  const input = normalizedString(configuredPath);
  if (!input) return { ok: false, reason: "path is empty" };
  if (input.includes("\0")) return { ok: false, reason: "path is invalid" };
  if (isAbsolute(input)) return { ok: false, reason: "path must be project-relative and must stay inside project cwd" };
  const projectRoot = resolve(cwd || process.cwd());
  const path = resolve(projectRoot, input);
  const rel = relative(projectRoot, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, reason: "path must be project-relative and must stay inside project cwd" };
  return { ok: true, path };
}

function normalizedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeSummaryString(value) {
  const redacted = redactPeerAuditValue(value);
  return normalizedString(typeof redacted === "string" ? redacted : undefined);
}

function configuredPeers(config, label, warnings) {
  if (Array.isArray(config)) {
    return config.flatMap((peer, index) => normalizeConfiguredPeer(peer, `${label}[${index}]`, warnings));
  }
  if (!isPlainObject(config)) return [];
  return Object.entries(config)
    .filter(([peerId]) => !["enabled", "experimental"].includes(peerId))
    .flatMap(([peerId, value]) => normalizeConfiguredPeer({ peerId, ...(isPlainObject(value) ? value : {}) }, `${label}.${peerId}`, warnings));
}

function buildDefaultPeerEntries(options = {}) {
  const localPeerId = normalizePeerId(options.localPeerId) || defaultLocalPeerId();
  const entries = isPlainObject(options.seedPeers) ? { ...options.seedPeers } : {};
  if (localPeerId && (options.role || options.persona)) {
    entries[localPeerId] = {
      ...(entries[localPeerId] || {}),
      ...(normalizedString(options.role) ? { role: normalizedString(options.role) } : {}),
      ...(normalizedString(options.persona) ? { persona: normalizedString(options.persona) } : {}),
      trust: options.trust || entries[localPeerId]?.trust || "conversation",
    };
  }
  return entries;
}

function normalizePeerManifest(manifest = {}) {
  const source = isPlainObject(manifest) ? manifest : {};
  return {
    ...peerProtocolMetadata(),
    ...(normalizedString(source.trust) ? { trust: normalizedString(source.trust) } : {}),
    capabilities: isPlainObject(source.capabilities) ? clonePlain(source.capabilities) : {},
    ...(Number.isInteger(source.protocolVersion) ? { protocolVersion: source.protocolVersion } : {}),
    ...(Number.isInteger(source.minProtocolVersion) ? { minProtocolVersion: source.minProtocolVersion } : {}),
    ...(Number.isInteger(source.maxProtocolVersion) ? { maxProtocolVersion: source.maxProtocolVersion } : {}),
  };
}

function manifestDefaults(manifest = {}) {
  return {
    ...(manifest.trust ? { trust: manifest.trust } : {}),
    ...(manifest.protocolVersion ? { protocolVersion: manifest.protocolVersion } : {}),
    ...(manifest.minProtocolVersion ? { minProtocolVersion: manifest.minProtocolVersion } : {}),
    ...(manifest.maxProtocolVersion ? { maxProtocolVersion: manifest.maxProtocolVersion } : {}),
    ...(manifest.capabilities && Object.keys(manifest.capabilities).length ? { capabilities: manifest.capabilities } : {}),
  };
}

function summarizePeerManifest(manifest = {}) {
  return {
    protocol: manifest.protocol || "pi-peer",
    protocolVersion: manifest.protocolVersion || PEER_VERSION,
    minProtocolVersion: manifest.minProtocolVersion || PEER_VERSION,
    maxProtocolVersion: manifest.maxProtocolVersion || PEER_VERSION,
    ...(manifest.trust ? { trust: manifest.trust } : {}),
    capabilities: clonePlain(manifest.capabilities || {}),
  };
}

function normalizeConfiguredPeer(peer, location, warnings) {
  if (!isPlainObject(peer)) {
    warnings.push(`${location} ignored because peer descriptor is not an object`);
    return [];
  }
  if (peer.enabled === false) return [];
  if (typeof peer.peerId !== "string" || !peer.peerId.trim()) {
    warnings.push(`${location} ignored because peerId is missing`);
    return [];
  }
  try {
    const manifest = normalizePeerManifest(peer.manifest);
    const merged = { ...manifestDefaults(manifest), ...peer, capabilities: { ...(manifest.capabilities || {}), ...(isPlainObject(peer.capabilities) ? peer.capabilities : {}) } };
    delete merged.manifest;
    return [normalizePeerDescriptor({ transport: "coms", trust: "read-only", ...merged })];
  } catch (error) {
    warnings.push(`${location} ignored: ${error.message}`);
    return [];
  }
}

function markUnsupportedTransport(peer, warnings) {
  if (!peer.compatible) {
    const unsupportedReason = `protocol v${peer.protocolVersion || "unknown"} is not compatible with this pi-peer runtime`;
    warnings.push(`${peer.peerId}: ${unsupportedReason}`);
    return { ...peer, status: "unsupported", unsupportedReason };
  }
  if (SUPPORTED_PEER_TRANSPORT_SET.has(peer.transport)) return peer;
  const unsupportedReason = `transport '${peer.transport}' is configured for future work; only local coms is enabled in this prototype`;
  warnings.push(`${peer.peerId}: ${unsupportedReason}`);
  return { ...peer, status: "unsupported", unsupportedReason };
}

function settingsEnabled(settings) {
  return settings?.experimental?.peerMessaging === true || settings?.peerMessaging?.enabled === true;
}

function configSource(hasSettings, hasPeerFile) {
  if (hasSettings && hasPeerFile) return `${PEER_SETTINGS_RELATIVE_PATH}+${PEER_CONFIG_RELATIVE_PATH}`;
  if (hasPeerFile) return PEER_CONFIG_RELATIVE_PATH;
  if (hasSettings) return PEER_SETTINGS_RELATIVE_PATH;
  return "none";
}

async function readJsonMaybe(path, readFile) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    error.message = `Failed to read peer config ${path}: ${error.message}`;
    throw error;
  }
}

function unique(values) {
  return [...new Set(values)];
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
