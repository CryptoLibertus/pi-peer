import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendPeerControlRecord, derivePeerControlState, loadPeerControlLedger } from "./control-ledger.mjs";

export const PEER_PROCESS_LEDGER_KIND = "peer-process";
export const DEFAULT_PEER_PROCESS_COMMAND = "pi";

const managedByRoot = new Map();
const CURRENT_EXTENSION_PATH = fileURLToPath(new URL("../../extensions/pi-peer/index.ts", import.meta.url));

export function normalizePeerProcessSpawnRequest(input = {}) {
  const source = plainObject(input) ? input : {};
  const action = cleanKey(source.spawnAction || source.action) || "start";
  const peerIds = normalizeList(source.peerIds || source.peers || source.peerId || source.peer);
  const count = positiveInteger(source.count);
  const prefix = cleanPeerId(source.prefix) || "worker";
  const generated = peerIds.length ? peerIds : count ? Array.from({ length: count }, (_item, index) => `${prefix}${index + 1}`) : [];
  return stripEmpty({
    action,
    peerIds: [...new Set(generated.map(cleanPeerId).filter(Boolean))],
    role: cleanKey(source.role),
    domain: cleanKey(source.domain),
    persona: cleanText(source.persona),
    subagents: booleanOption(source.subagents),
    subagentProvider: cleanKey(source.subagentProvider || source.provider || source.subagentsProvider),
    command: cleanText(source.command) || DEFAULT_PEER_PROCESS_COMMAND,
    model: cleanText(source.model),
    provider: cleanText(source.providerName || source.llmProvider),
    thinking: cleanText(source.thinking),
    includeCurrentExtension: source.includeCurrentExtension === true,
    noSession: source.noSession !== false,
    detached: source.detached === true,
  });
}

export async function startPeerProcesses(root, input = {}, options = {}) {
  const request = normalizePeerProcessSpawnRequest(input);
  if (!request.peerIds?.length) throw new Error("/peer spawn requires <peer-id[,peer-id]> or --count <n>");
  const runtimePeerId = cleanText(options.runtimePeerId || input.runtimePeerId || "unknown");
  const spawnFn = options.spawn || nodeSpawn;
  const envBase = options.env || process.env;
  const records = [];
  const rootKey = root || process.cwd();
  const managed = managedForRoot(rootKey);

  for (const peerId of request.peerIds) {
    if (managed.has(peerId) && !isExited(managed.get(peerId))) {
      records.push({ peerId, status: "already-running", pid: managed.get(peerId).pid });
      continue;
    }
    const env = buildPeerProcessEnv(envBase, request, peerId, runtimePeerId);
    const args = buildPeerProcessArgs(request);
    let child;
    try {
      child = spawnFn(request.command, args, {
        cwd: rootKey,
        env,
        stdio: ["pipe", "ignore", "ignore"],
        detached: request.detached === true,
      });
    } catch (error) {
      const record = { peerId, status: "error", error: errorMessage(error) };
      records.push(record);
      await recordPeerProcess(rootKey, { action: "error", status: "error", peerId, runtimePeerId, summary: record.error, metadata: { command: request.command, args } });
      continue;
    }
    child.__piPeerExited = false;
    child.__piPeerStopping = false;
    const ready = await waitForChildSpawn(child);
    if (!ready.ok) {
      child.__piPeerExited = true;
      const record = { peerId, status: "error", pid: child.pid, error: ready.error };
      records.push(record);
      await recordPeerProcess(rootKey, { action: "error", status: "error", peerId, runtimePeerId, pid: child.pid, summary: ready.error, metadata: { command: request.command, args } });
      continue;
    }
    child.once?.("exit", (code, signal) => {
      child.__piPeerExited = true;
      void recordPeerProcess(rootKey, {
        action: "exited",
        status: "exited",
        peerId,
        runtimePeerId,
        pid: child.pid,
        summary: `peer process exited${code === null || code === undefined ? "" : ` with code ${code}`}${signal ? ` signal ${signal}` : ""}`,
        metadata: { code, signal },
      }).catch(() => {});
    });
    child.once?.("error", (error) => {
      child.__piPeerExited = true;
      void recordPeerProcess(rootKey, { action: "error", status: "error", peerId, runtimePeerId, pid: child.pid, summary: errorMessage(error) }).catch(() => {});
    });
    managed.set(peerId, child);
    const record = { peerId, status: "running", pid: child.pid, command: request.command, args };
    records.push(record);
    await recordPeerProcess(rootKey, {
      action: "started",
      status: "running",
      peerId,
      runtimePeerId,
      pid: child.pid,
      summary: `spawned peer ${peerId}`,
      metadata: stripEmpty({ command: request.command, args, role: request.role, domain: request.domain, subagents: request.subagents, subagentProvider: request.subagentProvider }),
    });
  }

  return { ok: records.every((item) => item.status !== "error"), action: "start", records };
}

export async function stopPeerProcesses(root, input = {}, options = {}) {
  const request = normalizePeerProcessSpawnRequest({ ...input, action: "stop" });
  const rootKey = root || process.cwd();
  const managed = managedForRoot(rootKey);
  const ids = request.peerIds?.length ? request.peerIds : [...managed.keys()];
  const records = [];
  for (const peerId of ids) {
    const child = managed.get(peerId);
    if (!child || isExited(child)) {
      records.push({ peerId, status: "not-running" });
      continue;
    }
    const signal = cleanText(options.signal || input.signal) || "SIGTERM";
    const stopped = child.kill?.(signal) !== false;
    if (stopped) child.__piPeerStopping = true;
    records.push({ peerId, status: stopped ? "stopping" : "stop-failed", pid: child.pid, signal });
    await recordPeerProcess(rootKey, { action: stopped ? "stopping" : "stop-failed", status: stopped ? "stopping" : "error", peerId, pid: child.pid, summary: stopped ? `sent ${signal}` : `failed to send ${signal}` });
  }
  return { ok: records.every((item) => item.status !== "stop-failed"), action: "stop", records };
}

export async function listPeerProcesses(root, input = {}) {
  const rootKey = root || process.cwd();
  const managed = managedForRoot(rootKey);
  const loaded = await loadPeerControlLedger(rootKey).catch(() => ({ records: [] }));
  const state = derivePeerControlState(loaded.records || []);
  const managedRows = [...managed.entries()].map(([peerId, child]) => ({ peerId, pid: child.pid, status: childStatus(child) }));
  const ledgerRows = (loaded.records || [])
    .filter((record) => record.kind === PEER_PROCESS_LEDGER_KIND)
    .slice(-10)
    .map((record) => ({ peerId: record.peerId, pid: record.pid, status: record.status, action: record.action, summary: record.summary, at: record.at }));
  return { ok: true, action: "status", managed: managedRows, recent: ledgerRows };
}

export function formatPeerProcessResult(result = {}) {
  if (result.action === "status") {
    const lines = [`Peer processes: ${result.managed?.filter((item) => item.status === "running").length || 0} managed running`];
    if (result.managed?.length) {
      lines.push("Managed:");
      for (const item of result.managed) lines.push(`- ${item.peerId} · ${item.status}${item.pid ? ` · pid ${item.pid}` : ""}`);
    }
    if (result.recent?.length) {
      lines.push("Recent ledger:");
      for (const item of result.recent.slice(-5)) lines.push(`- ${item.peerId || "unknown"} · ${item.status || item.action || "unknown"}${item.pid ? ` · pid ${item.pid}` : ""}${item.summary ? ` · ${item.summary}` : ""}`);
    }
    if (!result.managed?.length && !result.recent?.length) lines.push("- none");
    return lines.join("\n");
  }
  const lines = [`Peer spawn ${result.action || "result"}: ${result.ok === false ? "completed with errors" : "ok"}`];
  for (const item of result.records || []) lines.push(`- ${item.peerId} · ${item.status}${item.pid ? ` · pid ${item.pid}` : ""}${item.error ? ` · ${item.error}` : ""}`);
  if (result.action === "start") lines.push("", "Next: /peer reconnect, then /peer list. Stop managed children with /peer spawn stop [peer-id].");
  return lines.join("\n");
}

export function buildPeerProcessArgs(request = {}) {
  const args = ["--mode", "rpc"];
  if (request.noSession !== false) args.push("--no-session");
  if (request.includeCurrentExtension) args.push("--extension", CURRENT_EXTENSION_PATH);
  if (request.model) args.push("--model", request.model);
  if (request.provider) args.push("--provider", request.provider);
  if (request.thinking) args.push("--thinking", request.thinking);
  return args;
}

function buildPeerProcessEnv(base, request, peerId, parentPeerId) {
  const env = { ...base, PI_PEER_ID: peerId, PI_PEER_PARENT_ID: parentPeerId, PI_PEER_SPAWNED: "1" };
  if (request.role) env.PI_PEER_ROLE = request.role;
  if (request.domain) env.PI_PEER_DOMAIN = request.domain;
  if (request.persona) env.PI_PEER_PERSONA = request.persona;
  if (request.subagents === true) env.PI_PEER_SUBAGENTS = "1";
  if (request.subagents === false) env.PI_PEER_SUBAGENTS = "0";
  if (request.subagentProvider) env.PI_PEER_SUBAGENT_PROVIDER = request.subagentProvider;
  return env;
}

async function recordPeerProcess(root, input = {}) {
  return appendPeerControlRecord(root, {
    kind: PEER_PROCESS_LEDGER_KIND,
    ...input,
    metadata: stripEmpty(input.metadata || {}),
  });
}

function managedForRoot(root) {
  const key = root || process.cwd();
  if (!managedByRoot.has(key)) managedByRoot.set(key, new Map());
  return managedByRoot.get(key);
}

function waitForChildSpawn(child, timeoutMs = 1_500, settleMs = 100) {
  if (!child || typeof child.once !== "function") return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let settleTimer;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(settleTimer);
      child.off?.("spawn", onSpawn);
      child.off?.("error", onError);
      child.off?.("exit", onEarlyExit);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onSpawn = () => {
      clearTimeout(timer);
      settleTimer = setTimeout(() => finish({ ok: true }), settleMs);
      settleTimer.unref?.();
    };
    const onError = (error) => finish({ ok: false, error: errorMessage(error) });
    const onEarlyExit = (code, signal) => finish({ ok: false, error: `process exited before ready${code === null || code === undefined ? "" : ` with code ${code}`}${signal ? ` signal ${signal}` : ""}` });
    timer = setTimeout(() => finish({ ok: true, timeout: true }), timeoutMs);
    timer.unref?.();
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onEarlyExit);
  });
}

function isExited(child) {
  return child?.__piPeerExited === true || child?.exitCode !== null && child?.exitCode !== undefined;
}

function childStatus(child) {
  if (isExited(child)) return "exited";
  if (child?.__piPeerStopping === true) return "stopping";
  return "running";
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeList(item));
  if (typeof value === "string") return value.split(",").map(cleanText).filter(Boolean);
  return [];
}

function cleanPeerId(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function cleanKey(value) {
  return cleanPeerId(value);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function booleanOption(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(text)) return true;
    if (["false", "0", "no", "n", "off"].includes(text)) return false;
  }
  return undefined;
}

function errorMessage(error) {
  return cleanText(error?.message || error) || "unknown error";
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
