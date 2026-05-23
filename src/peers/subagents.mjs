import { randomUUID } from "node:crypto";
import { appendPeerControlRecord, derivePeerControlState, loadPeerControlLedger } from "./control-ledger.mjs";
import { completePeerGoalTask } from "./goal-board.mjs";
import { loadPeerOrg } from "./org.mjs";

export const PEER_SUBAGENT_LEDGER_KIND = "subrun";

const SUPPORTED_MODES = new Set(["single", "parallel", "chain", "async"]);
const PROVIDER_STARTERS = ["startPeerSubagents", "startSubagentRun", "runSubagents"];

export function normalizeSubagentRunRequest(input = {}) {
  const source = plainObject(input) ? input : {};
  const mode = cleanKey(source.mode);
  return stripEmpty({
    subrunId: cleanText(source.subrunId || source.runId),
    summary: cleanText(source.summary || source.objective || source.prompt),
    goalId: cleanText(source.goalId),
    parentPeerId: cleanText(source.parentPeerId || source.peerId || source.targetPeerId),
    provider: cleanKey(source.provider),
    mode: SUPPORTED_MODES.has(mode) ? mode : "single",
    workKey: cleanText(source.workKey),
    artifactRefs: normalizeList(source.artifactRefs || source.artifacts || source.artifact),
    childCount: nonNegativeInteger(source.childCount),
    doneCount: nonNegativeInteger(source.doneCount ?? source.completedCount),
    blockedCount: nonNegativeInteger(source.blockedCount),
    attachHandoff: source.attachHandoff === true,
    importModule: typeof source.importModule === "function" ? source.importModule : undefined,
    org: source.org,
    capabilities: source.capabilities,
  });
}

export function normalizeSubagentRunSummary(input = {}) {
  const source = plainObject(input) ? input : {};
  return stripEmpty({
    ok: typeof source.ok === "boolean" ? source.ok : undefined,
    subrunId: cleanText(source.subrunId || source.runId),
    status: cleanKey(source.status),
    provider: cleanKey(source.provider),
    mode: cleanKey(source.mode),
    summary: cleanText(source.summary),
    goalId: cleanText(source.goalId),
    parentPeerId: cleanText(source.parentPeerId || source.peerId),
    artifactRefs: normalizeList(source.artifactRefs || source.artifacts || source.artifact),
    childCount: nonNegativeInteger(source.childCount),
    doneCount: nonNegativeInteger(source.doneCount ?? source.completedCount),
    blockedCount: nonNegativeInteger(source.blockedCount),
    message: cleanText(source.message),
  });
}

export async function resolveSubagentProvider(root, input = {}) {
  const request = normalizeSubagentRunRequest(input);
  const org = await resolveOrg(root, input);
  const providerName = cleanKey(request.provider)
    || cleanKey(org?.spawnPolicy?.provider)
    || cleanKey(input?.capabilities?.orchestration?.provider || org?.capabilities?.orchestration?.provider)
    || "manual";

  if (providerName === "manual") {
    return { name: "manual", available: true, module: undefined, starter: undefined };
  }

  const importModule = request.importModule || ((name) => import(name).catch(() => undefined));
  const providerModule = await importProviderModule(importModule, providerName);
  const starter = PROVIDER_STARTERS.find((name) => typeof providerModule?.[name] === "function");
  return {
    name: providerName,
    available: Boolean(starter),
    module: providerModule,
    starter,
  };
}

export async function startPeerSubagentRun(root, input = {}) {
  const request = normalizeSubagentRunRequest(input);
  const provider = await resolveSubagentProvider(root, input);
  const subrunId = request.subrunId || newSubrunId();
  const common = {
    subrunId,
    goalId: request.goalId,
    peerId: request.parentPeerId,
    summary: request.summary || "Peer subagent run",
    metadata: subrunMetadata({ ...request, provider: provider.name }),
  };

  if (!provider.available) {
    const message = `subagent provider unavailable: ${provider.name}`;
    await appendPeerControlRecord(root, {
      ...common,
      kind: PEER_SUBAGENT_LEDGER_KIND,
      action: "blocked",
      status: "blocked",
      summary: request.summary || message,
    });
    return normalizeSubagentRunSummary({ ...request, subrunId, provider: provider.name, status: "blocked", message, ok: false });
  }

  await appendPeerControlRecord(root, {
    ...common,
    kind: PEER_SUBAGENT_LEDGER_KIND,
    action: "started",
    status: "running",
  });

  if (provider.starter) {
    await provider.module[provider.starter]({ ...request, subrunId, provider: provider.name });
  }

  return normalizeSubagentRunSummary({ ...request, subrunId, provider: provider.name, status: "running", ok: true });
}

export async function recordPeerSubagentRunProgress(root, input = {}) {
  const request = await enrichRequestFromLedger(root, normalizeSubagentRunRequest(input));
  const provider = cleanKey(request.provider) || "manual";
  await appendPeerControlRecord(root, {
    kind: PEER_SUBAGENT_LEDGER_KIND,
    action: "progress",
    status: "progress",
    subrunId: requiredSubrunId(request.subrunId),
    goalId: request.goalId,
    peerId: request.parentPeerId,
    workKey: request.workKey,
    summary: request.summary || "Peer subagent progress",
    metadata: subrunMetadata({ ...request, provider }),
  });
  return normalizeSubagentRunSummary({ ...request, provider, status: "progress", ok: true });
}

export async function completePeerSubagentRun(root, input = {}) {
  const request = await enrichRequestFromLedger(root, normalizeSubagentRunRequest(input));
  const provider = cleanKey(request.provider) || "manual";
  const status = completionStatus(request);
  const subrunId = requiredSubrunId(request.subrunId);
  const summary = request.summary || "Peer subagent run completed";

  await appendPeerControlRecord(root, {
    kind: PEER_SUBAGENT_LEDGER_KIND,
    action: "done",
    status,
    subrunId,
    goalId: request.goalId,
    peerId: request.parentPeerId,
    workKey: request.workKey,
    summary,
    metadata: subrunMetadata({ ...request, provider }),
  });

  if (request.attachHandoff && request.goalId) {
    await completePeerGoalTask(root, request.goalId, {
      targetPeerId: request.parentPeerId,
      messageId: subrunId,
      status,
      summary,
      workKey: request.workKey,
      subagentEvidence: subagentEvidence({ ...request, subrunId, provider }),
    });
  }

  return normalizeSubagentRunSummary({ ...request, subrunId, provider, status, ok: true });
}

export async function cancelPeerSubagentRun(root, input = {}) {
  const request = await enrichRequestFromLedger(root, normalizeSubagentRunRequest(input));
  const provider = cleanKey(request.provider) || "manual";
  const subrunId = requiredSubrunId(request.subrunId);
  await appendPeerControlRecord(root, {
    kind: PEER_SUBAGENT_LEDGER_KIND,
    action: "cancelled",
    status: "cancelled",
    subrunId,
    goalId: request.goalId,
    peerId: request.parentPeerId,
    workKey: request.workKey,
    summary: request.summary || "Peer subagent run cancelled",
    metadata: subrunMetadata({ ...request, provider }),
  });
  return normalizeSubagentRunSummary({ ...request, subrunId, provider, status: "cancelled", ok: true });
}

export function formatPeerSubagentRunResult(result = {}) {
  const summary = normalizeSubagentRunSummary(result);
  const bits = ["Subrun", summary.subrunId || "unknown", summary.status || "unknown"];
  if (summary.provider) bits.push(`provider ${summary.provider}`);
  if (summary.mode) bits.push(`mode ${summary.mode}`);
  if (summary.childCount !== undefined) bits.push(`children ${summary.childCount}`);
  if (summary.doneCount !== undefined) bits.push(`done ${summary.doneCount}`);
  if (summary.blockedCount !== undefined) bits.push(`blocked ${summary.blockedCount}`);
  if (summary.artifactRefs?.length) bits.push(`artifacts ${summary.artifactRefs.join(",")}`);
  if (summary.summary) bits.push(summary.summary);
  if (summary.message) bits.push(summary.message);
  return bits.join(" · ");
}

export function formatPeerSubagentStatus(input = {}) {
  const state = input.controlState || input.state || derivePeerControlState(input.records || []);
  const active = Array.isArray(state.activeSubruns) ? state.activeSubruns.length : 0;
  const completed = Array.isArray(state.completedSubruns) ? state.completedSubruns.length : 0;
  const lines = [`Subruns: ${active} active · ${completed} completed`];
  const runs = [...(state.activeSubruns || []), ...(state.completedSubruns || [])].slice(0, 5);
  for (const run of runs) {
    const bits = [`- ${run.subrunId}`, run.status];
    if (run.provider) bits.push(run.provider);
    if (run.mode) bits.push(run.mode);
    if (run.childCount !== undefined) bits.push(`children ${run.childCount}`);
    if (run.completedCount !== undefined) bits.push(`done ${run.completedCount}`);
    if (run.blockedCount !== undefined) bits.push(`blocked ${run.blockedCount}`);
    if (run.artifactRefs?.length) bits.push(`artifacts ${run.artifactRefs.join(",")}`);
    lines.push(bits.filter(Boolean).join(" · "));
  }
  return lines.join("\n");
}

async function resolveOrg(root, input = {}) {
  if (plainObject(input.org?.org)) return input.org.org;
  if (plainObject(input.org)) return input.org;
  if (!root) return {};
  const loaded = await loadPeerOrg(root, { allowMissing: true }).catch(() => undefined);
  return loaded?.exists ? loaded.org : {};
}

async function importProviderModule(importModule, providerName) {
  try {
    return await importModule(providerName);
  } catch {
    return undefined;
  }
}

function subrunMetadata(input = {}) {
  return stripEmpty({
    provider: cleanKey(input.provider),
    mode: cleanKey(input.mode),
    artifactRefs: normalizeList(input.artifactRefs),
    childCount: nonNegativeInteger(input.childCount),
    completedCount: nonNegativeInteger(input.doneCount ?? input.completedCount),
    blockedCount: nonNegativeInteger(input.blockedCount),
    parentPeerId: cleanText(input.parentPeerId),
    goalId: cleanText(input.goalId),
    workKey: cleanText(input.workKey),
  });
}

function subagentEvidence(input = {}) {
  return stripEmpty({
    subrunId: cleanText(input.subrunId),
    provider: cleanKey(input.provider),
    mode: cleanKey(input.mode),
    childCount: nonNegativeInteger(input.childCount),
    doneCount: nonNegativeInteger(input.doneCount ?? input.completedCount),
    blockedCount: nonNegativeInteger(input.blockedCount),
    artifactRefs: normalizeList(input.artifactRefs),
  });
}

async function enrichRequestFromLedger(root, request = {}) {
  if (!root || !request.subrunId) return request;
  const loaded = await loadPeerControlLedger(root).catch(() => undefined);
  const state = derivePeerControlState(loaded?.records || []);
  const existing = state.subruns?.find((run) => run.subrunId === request.subrunId);
  if (!existing) return request;
  return {
    ...request,
    goalId: request.goalId || existing.goalId,
    parentPeerId: request.parentPeerId || existing.parentPeerId,
    provider: request.provider || existing.provider,
    mode: request.mode === "single" && existing.mode ? existing.mode : request.mode,
    workKey: request.workKey || existing.workKey,
  };
}

function completionStatus(request = {}) {
  const doneCount = nonNegativeInteger(request.doneCount);
  const blockedCount = nonNegativeInteger(request.blockedCount);
  if ((blockedCount || 0) > 0 && (doneCount || 0) > 0) return "partial";
  if ((blockedCount || 0) > 0) return "blocked";
  return "done";
}

function newSubrunId() {
  return `sub_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function requiredSubrunId(value) {
  const subrunId = cleanText(value);
  if (!subrunId) throw new Error("peer subagent run requires subrunId");
  return subrunId;
}

function normalizeList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(cleanText).filter(Boolean))];
  if (typeof value === "string") return value.split(",").map(cleanText).filter(Boolean);
  return [];
}

function nonNegativeInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function cleanKey(value) {
  return cleanText(value).toLowerCase();
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === undefined || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}
