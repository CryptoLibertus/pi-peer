import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import { redactPeerAuditValue } from "./protocol.mjs";

export const PEER_MESSAGE_STORE_RELATIVE_PATH = ".pi/peer-messages.json";

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
        const normalized = normalizePeerMessageStore(redactPeerAuditValue(state, { homeDir }));
        await mkdir(dirname(path), { recursive: true });
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
