import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { initPeerConfig, loadPeerRuntimeConfig, PEER_CONFIG_RELATIVE_PATH } from "./config.mjs";
import { setPeerOrgRole } from "./org.mjs";

export const PEER_SETUP_SESSION_RELATIVE_PATH = ".pi/peer-setup-session.json";

export const PEER_SETUP_CHOICES = Object.freeze({
  coordinate: Object.freeze({
    role: "coordinator",
    domain: "coordination",
    canSpawnSubagents: true,
    countsForIndependentVote: true,
  }),
  implement: Object.freeze({
    role: "implementer",
    domain: "implementation",
    canSpawnSubagents: true,
    countsForIndependentVote: false,
  }),
  review: Object.freeze({
    role: "reviewer",
    domain: "review",
    canSpawnSubagents: true,
    countsForIndependentVote: true,
  }),
  research: Object.freeze({
    role: "researcher",
    domain: "research",
    canSpawnSubagents: true,
    countsForIndependentVote: true,
  }),
  subagents: Object.freeze({
    role: "coordinator",
    domain: "coordination",
    canSpawnSubagents: true,
    countsForIndependentVote: true,
    forceSubagents: true,
  }),
  status: Object.freeze({
    role: undefined,
    domain: undefined,
    canSpawnSubagents: false,
    countsForIndependentVote: undefined,
    inspectOnly: true,
  }),
});

const SETUP_ID_GUIDANCE = "Run /peer setup id <peer-id> first, then repeat /peer setup <choice>.";

const SUBAGENT_CAPABILITIES = Object.freeze({
  orchestration: Object.freeze({
    subagents: true,
    provider: "pi-subagents",
    modes: Object.freeze(["single", "parallel", "chain", "async"]),
    maxDepth: 1,
    maxConcurrency: 4,
    worktree: true,
    intercom: false,
  }),
});

export function setupWizardPath(root) {
  if (!root) throw new Error("peer setup wizard requires root");
  return resolve(root, PEER_SETUP_SESSION_RELATIVE_PATH);
}

export async function loadPeerSetupSession(root) {
  const path = setupWizardPath(root);
  const relativePath = PEER_SETUP_SESSION_RELATIVE_PATH;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, path, relativePath };
    throw error;
  }
  return normalizePeerSetupSession(parsed, { exists: true, path, relativePath });
}

export async function savePeerSetupSession(root, input = {}) {
  const path = setupWizardPath(root);
  const relativePath = PEER_SETUP_SESSION_RELATIVE_PATH;
  const session = normalizePeerSetupSession(input, { exists: true, path, relativePath });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(stripRuntimeFields(session), null, 2)}\n`, "utf8");
  return session;
}

export async function resetPeerSetupSession(root) {
  const path = setupWizardPath(root);
  try {
    await rm(path);
    return { ok: true, removed: true, path, relativePath: PEER_SETUP_SESSION_RELATIVE_PATH };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, removed: false, path, relativePath: PEER_SETUP_SESSION_RELATIVE_PATH };
    throw error;
  }
}

export function normalizePeerSetupChoice(value) {
  const token = cleanKey(value);
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

export function formatPeerSetupPrompt(input = {}) {
  const peer = cleanText(input.peerId || input.localPeerId);
  return [
    "What do you want this session to do?",
    "",
    "1. Coordinate other peers",
    "2. Implement code",
    "3. Review work",
    "4. Research",
    "5. Manage private subagents",
    "6. Inspect status only",
    "",
    "Reply with /peer setup <number>.",
    peer ? `Current peer: ${peer}` : undefined,
  ].filter(Boolean).join("\n");
}

export async function applyPeerSetupChoice(root, input = {}) {
  if (!root) throw new Error("peer setup wizard requires root");
  const choice = normalizePeerSetupChoice(input.choice || input.setupChoice);
  if (!choice) throw new Error("Unknown peer setup choice");

  const setup = PEER_SETUP_CHOICES[choice];
  if (setup.inspectOnly) {
    const session = await savePeerSetupSession(root, {
      version: 1,
      choice,
      inspectOnly: true,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, choice, inspectOnly: true, session };
  }

  const runtime = input.runtime || await loadRuntimeIdentity(root, input);
  const peerId = resolveSetupPeerId(input, runtime);
  const capabilities = setup.canSpawnSubagents ? clonePlain(SUBAGENT_CAPABILITIES) : {};

  const configExists = await peerConfigExists(root);
  const init = configExists
    ? { ok: true, created: false, existed: true, path: resolve(root, PEER_CONFIG_RELATIVE_PATH), relativePath: PEER_CONFIG_RELATIVE_PATH }
    : await initPeerConfig(root, {
      localPeerId: peerId,
      role: setup.role,
      domain: setup.domain,
      capabilities,
    });
  if (configExists) await fillExistingPeerConfig(root, peerId, setup, capabilities);

  const orgResult = await setPeerOrgRole(root, peerId, {
    role: setup.role,
    domain: setup.domain,
    canSpawnSubagents: setup.canSpawnSubagents,
    countsForIndependentVote: setup.countsForIndependentVote,
  });

  const session = await savePeerSetupSession(root, {
    version: 1,
    peerId,
    choice,
    role: setup.role,
    domain: setup.domain,
    canSpawnSubagents: setup.canSpawnSubagents,
    updatedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    choice,
    peerId,
    role: setup.role,
    domain: setup.domain,
    canSpawnSubagents: setup.canSpawnSubagents,
    capabilities,
    init,
    org: orgResult,
    session,
  };
}

export function formatPeerSetupResult(result = {}) {
  if (result.inspectOnly) {
    return [
      "Peer setup updated",
      "Inspect only: yes",
      "Next:",
      "1. /peer center",
      "2. /peer setup done",
    ].join("\n");
  }
  return [
    "Peer setup updated",
    `Local: ${result.peerId || "unknown"}`,
    `Role: ${result.role || "unknown"}`,
    `Domain: ${result.domain || "unknown"}`,
    `Subagents: ${result.canSpawnSubagents ? "yes" : "no"}`,
    "Next:",
    "1. /peer center",
    "2. /peer setup done",
  ].join("\n");
}

async function loadRuntimeIdentity(root, input = {}) {
  const config = await loadPeerRuntimeConfig(root, { env: input.env || process.env });
  return {
    localPeerId: config.localPeerId,
    localPeerIdSource: config.localPeerIdSource,
    summary: {
      localPeerId: config.localPeerId,
      localPeerIdSource: config.localPeerIdSource,
    },
  };
}

function resolveSetupPeerId(input = {}, runtime = {}) {
  const explicitPeerId = cleanPeerId(input.peerId || input.localPeerId);
  if (explicitPeerId) return explicitPeerId;

  const runtimePeerId = cleanPeerId(runtime.localPeerId);
  if (runtimePeerId) {
    assertStableIdentitySource(runtime.localPeerIdSource || runtime.summary?.localPeerIdSource || runtime.config?.localPeerIdSource);
    return runtimePeerId;
  }

  const summaryPeerId = cleanPeerId(runtime.summary?.localPeerId);
  if (summaryPeerId) {
    assertStableIdentitySource(runtime.summary?.localPeerIdSource || runtime.config?.localPeerIdSource);
    return summaryPeerId;
  }

  throw new Error(SETUP_ID_GUIDANCE);
}

function assertStableIdentitySource(source) {
  const normalized = cleanKey(source);
  if (!normalized || normalized === "generated") throw new Error(SETUP_ID_GUIDANCE);
}

async function fillExistingPeerConfig(root, peerId, setup, capabilities) {
  const path = resolve(root, PEER_CONFIG_RELATIVE_PATH);
  const raw = JSON.parse(await readFile(path, "utf8"));
  const config = plainObject(raw) ? raw : {};

  if (config.enabled === undefined) config.enabled = true;
  if (!cleanPeerId(config.localPeerId)) config.localPeerId = peerId;
  const profile = ensureLocalPeerProfile(config, peerId);
  if (!cleanText(profile.role) && setup.role) profile.role = setup.role;
  if (!cleanText(profile.domain) && setup.domain) profile.domain = setup.domain;

  if (capabilities?.orchestration) {
    if (!plainObject(config.manifest)) config.manifest = {};
    if (!plainObject(config.manifest.capabilities)) config.manifest.capabilities = {};
    if (!plainObject(config.manifest.capabilities.orchestration)) {
      config.manifest.capabilities.orchestration = clonePlain(capabilities.orchestration);
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function peerConfigExists(root) {
  try {
    await readFile(resolve(root, PEER_CONFIG_RELATIVE_PATH), "utf8");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function ensureLocalPeerProfile(config, peerId) {
  if (Array.isArray(config.peers)) {
    let profile = config.peers.find((peer) => plainObject(peer) && cleanPeerId(peer.peerId) === peerId);
    if (!profile) {
      profile = { peerId };
      config.peers.push(profile);
    }
    return profile;
  }

  if (!plainObject(config.peers)) config.peers = {};
  if (!plainObject(config.peers[peerId])) config.peers[peerId] = {};
  return config.peers[peerId];
}

function normalizePeerSetupSession(input = {}, meta = {}) {
  const source = plainObject(input) ? input : {};
  const choice = normalizePeerSetupChoice(source.choice) || cleanKey(source.choice);
  const session = {
    ...meta,
    version: Number.isInteger(source.version) ? source.version : 1,
    ...(cleanPeerId(source.peerId) ? { peerId: cleanPeerId(source.peerId) } : {}),
    ...(choice ? { choice } : {}),
    ...(cleanKey(source.role) ? { role: cleanKey(source.role) } : {}),
    ...(cleanKey(source.domain) ? { domain: cleanKey(source.domain) } : {}),
    ...(typeof source.canSpawnSubagents === "boolean" ? { canSpawnSubagents: source.canSpawnSubagents } : {}),
    ...(source.inspectOnly === true ? { inspectOnly: true } : {}),
    ...(cleanText(source.updatedAt) ? { updatedAt: cleanText(source.updatedAt) } : {}),
  };
  return session;
}

function stripRuntimeFields(session = {}) {
  const { exists, path, relativePath, ...persisted } = session;
  return persisted;
}

function cleanPeerId(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
    : undefined;
}

function cleanKey(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
