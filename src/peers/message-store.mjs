import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { redactPeerAuditValue } from "./protocol.mjs";

export const PEER_MESSAGE_STORE_RELATIVE_PATH = ".pi/peer-messages.json";

const TERMINAL_MESSAGE_STATUSES = new Set(["responded", "cancelled", "error", "dead-letter"]);
const MESSAGE_STORE_LOCK_STALE_MS = 30_000;
const MESSAGE_STORE_LOCK_RETRY_MS = 10;
const MESSAGE_STORE_LOCK_TIMEOUT_MS = 5_000;

export function createPeerMessageStore(root, options = {}) {
  const path = options.path || messageStorePath(root);
  const homeDir = options.homeDir || process.env.HOME || "";
  let pendingSave = Promise.resolve();
  return {
    path,
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        return normalizePeerMessageStore(parsed);
      } catch (error) {
        if (error?.code === "ENOENT") return normalizePeerMessageStore({});
        throw error;
      }
    },
    async save(state = {}) {
      pendingSave = pendingSave.catch(() => {}).then(async () => {
        const incoming = normalizePeerMessageStore(redactPeerAuditValue(state, { homeDir }));
        await mkdir(dirname(path), { recursive: true });
        return withMessageStoreLock(path, async () => {
          const existing = await readExistingPeerMessageStore(path);
          const normalized = mergePeerMessageStores(existing, incoming);
          const tmp = `${path}.${process.pid}.${process.hrtime.bigint().toString(36)}.tmp`;
          try {
            await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
            await rename(tmp, path);
          } catch (error) {
            await unlink(tmp).catch(() => {});
            throw error;
          }
          return normalized;
        });
      });
      return pendingSave;
    },
    async flush() {
      return pendingSave.catch(() => undefined);
    },
  };
}

export function normalizePeerMessageStore(state = {}) {
  const messages = Array.isArray(state.messages) ? state.messages : Object.values(state.messages || {});
  const conversations = Array.isArray(state.conversations) ? state.conversations : Object.values(state.conversations || {});
  return {
    version: 1,
    updatedAt: typeof state.updatedAt === "string" && state.updatedAt ? state.updatedAt : new Date().toISOString(),
    messages: messages.filter(isPlainObject).map(normalizeMessageSnapshot).filter(Boolean),
    conversations: conversations.filter(isPlainObject).map(normalizeConversationSnapshot).filter(Boolean),
  };
}

export function mergePeerMessageStores(existing = {}, incoming = {}) {
  const left = normalizePeerMessageStore(existing);
  const right = normalizePeerMessageStore(incoming);
  const messagesById = new Map();
  for (const message of left.messages) messagesById.set(message.messageId, message);
  for (const message of right.messages) {
    const previous = messagesById.get(message.messageId);
    messagesById.set(message.messageId, newerSnapshot(previous, message));
  }

  const conversationsById = new Map();
  for (const conversation of left.conversations) conversationsById.set(conversation.conversationId, conversation);
  for (const conversation of right.conversations) {
    const previous = conversationsById.get(conversation.conversationId);
    conversationsById.set(conversation.conversationId, mergeConversationSnapshot(previous, conversation));
  }

  return {
    version: 1,
    updatedAt: newerTimestamp(left.updatedAt, right.updatedAt) || new Date().toISOString(),
    messages: [...messagesById.values()].sort(sortByUpdatedAtThenId),
    conversations: [...conversationsById.values()].sort(sortByUpdatedAtThenId),
  };
}

function normalizeMessageSnapshot(message) {
  const messageId = cleanText(message.messageId);
  const conversationId = cleanText(message.conversationId);
  if (!messageId || !conversationId) return undefined;
  return stripEmpty({
    messageId,
    conversationId,
    peerId: cleanText(message.peerId),
    status: cleanText(message.status || "unknown"),
    request: isPlainObject(message.request) ? message.request : undefined,
    response: isPlainObject(message.response) ? message.response : null,
    responseEnvelope: isPlainObject(message.responseEnvelope) ? message.responseEnvelope : null,
    events: Array.isArray(message.events) ? message.events.filter(isPlainObject).slice(-50) : [],
    error: isPlainObject(message.error) ? message.error : null,
    createdAt: cleanText(message.createdAt),
    updatedAt: cleanText(message.updatedAt || message.createdAt),
    lastEvent: isPlainObject(message.lastEvent) ? message.lastEvent : undefined,
    lastHeartbeatAt: cleanText(message.lastHeartbeatAt),
    recoveredAt: cleanText(message.recoveredAt),
    traceId: cleanText(message.traceId || message.request?.body?.metadata?.traceId),
    spanId: cleanText(message.spanId || message.request?.body?.metadata?.spanId),
    retryPolicy: isPlainObject(message.retryPolicy) ? message.retryPolicy : undefined,
  });
}

function normalizeConversationSnapshot(conversation) {
  const conversationId = cleanText(conversation.conversationId);
  if (!conversationId) return undefined;
  return stripEmpty({
    conversationId,
    peerIds: normalizeStringList(conversation.peerIds),
    messageIds: normalizeStringList(conversation.messageIds),
    status: cleanText(conversation.status || "unknown"),
    createdAt: cleanText(conversation.createdAt),
    updatedAt: cleanText(conversation.updatedAt || conversation.createdAt),
  });
}

async function readExistingPeerMessageStore(path) {
  try {
    return normalizePeerMessageStore(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return normalizePeerMessageStore({});
    throw error;
  }
}

function newerSnapshot(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftTerminal = TERMINAL_MESSAGE_STATUSES.has(cleanText(left.status).toLowerCase());
  const rightTerminal = TERMINAL_MESSAGE_STATUSES.has(cleanText(right.status).toLowerCase());
  if (leftTerminal !== rightTerminal) return leftTerminal ? left : right;
  const leftTime = cleanText(left.updatedAt || left.createdAt);
  const rightTime = cleanText(right.updatedAt || right.createdAt);
  if (!leftTime && rightTime) return right;
  if (leftTime && !rightTime) return left;
  return rightTime >= leftTime ? right : left;
}

function mergeConversationSnapshot(left, right) {
  if (!left) return right;
  if (!right) return left;
  const newer = newerSnapshot(left, right);
  const older = newer === right ? left : right;
  return stripEmpty({
    ...newer,
    peerIds: [...new Set([...(older.peerIds || []), ...(newer.peerIds || [])])],
    messageIds: [...new Set([...(older.messageIds || []), ...(newer.messageIds || [])])],
    createdAt: older.createdAt && newer.createdAt ? (older.createdAt < newer.createdAt ? older.createdAt : newer.createdAt) : newer.createdAt || older.createdAt,
    updatedAt: newerTimestamp(older.updatedAt, newer.updatedAt) || newer.updatedAt || older.updatedAt,
  });
}

function newerTimestamp(left, right) {
  const a = cleanText(left);
  const b = cleanText(right);
  if (!a) return b;
  if (!b) return a;
  return b >= a ? b : a;
}

function sortByUpdatedAtThenId(a, b) {
  const timeCompare = String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
  if (timeCompare) return timeCompare;
  return String(a.messageId || a.conversationId || "").localeCompare(String(b.messageId || b.conversationId || ""));
}

async function withMessageStoreLock(path, fn) {
  const lockPath = `${path}.lock`;
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(`${lockPath}/owner`, `${process.pid}\n${new Date().toISOString()}\n`, "utf8").catch(() => {});
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await removeStaleMessageStoreLock(lockPath)) continue;
      if (Date.now() - start >= MESSAGE_STORE_LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for peer message store lock ${lockPath}`);
      await sleep(MESSAGE_STORE_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleMessageStoreLock(lockPath) {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < MESSAGE_STORE_LOCK_STALE_MS) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

function messageStorePath(root) {
  if (!root) throw new Error("peer message store requires root");
  return resolvePath(root, PEER_MESSAGE_STORE_RELATIVE_PATH);
}

function normalizeStringList(value) {
  return Array.isArray(value) ? [...new Set(value.map(cleanText).filter(Boolean))] : [];
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === undefined || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}
