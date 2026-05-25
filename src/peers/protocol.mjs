const PEER_PROTOCOL = "pi-peer";
const PEER_VERSION = 1;
const PEER_MIN_COMPATIBLE_VERSION = 1;
const PEER_MAX_COMPATIBLE_VERSION = 1;
const PEER_AUTH_TYPE_SHARED_TOKEN = "shared-token";

export { PEER_PROTOCOL, PEER_VERSION, PEER_MIN_COMPATIBLE_VERSION, PEER_MAX_COMPATIBLE_VERSION, PEER_AUTH_TYPE_SHARED_TOKEN };

export function peerProtocolMetadata() {
  return {
    protocol: PEER_PROTOCOL,
    protocolVersion: PEER_VERSION,
    minProtocolVersion: PEER_MIN_COMPATIBLE_VERSION,
    maxProtocolVersion: PEER_MAX_COMPATIBLE_VERSION,
  };
}

export function isPeerProtocolCompatible(source = {}) {
  const protocol = nonEmptyString(source.protocol) ? source.protocol : PEER_PROTOCOL;
  const version = Number.isInteger(source.protocolVersion) ? source.protocolVersion : Number.isInteger(source.version) ? source.version : PEER_VERSION;
  const min = Number.isInteger(source.minProtocolVersion) ? source.minProtocolVersion : version;
  const max = Number.isInteger(source.maxProtocolVersion) ? source.maxProtocolVersion : version;
  return protocol === PEER_PROTOCOL && min <= PEER_VERSION && max >= PEER_MIN_COMPATIBLE_VERSION;
}

export const PEER_MESSAGE_TYPES = Object.freeze([
  "hello",
  "registry.query",
  "registry.update",
  "message.send",
  "message.accepted",
  "message.event",
  "message.response",
  "message.cancel",
  "message.error",
  "approval.request",
  "approval.response",
  "heartbeat",
  "goodbye",
]);

const PEER_MESSAGE_TYPE_SET = new Set(PEER_MESSAGE_TYPES);

export function validatePeerEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, errors: ["envelope must be an object"] };
  }

  if (envelope.protocol !== PEER_PROTOCOL) errors.push(`protocol must be ${PEER_PROTOCOL}`);
  if (envelope.version !== PEER_VERSION) errors.push(`version must be ${PEER_VERSION}`);
  if (!PEER_MESSAGE_TYPE_SET.has(envelope.type)) errors.push(`type must be one of ${PEER_MESSAGE_TYPES.join(", ")}`);
  if (!nonEmptyString(envelope.id)) errors.push("id must be a non-empty string");
  if (!nonEmptyString(envelope.conversationId)) errors.push("conversationId must be a non-empty string");
  errors.push(...validatePeerAddress(envelope.source, "source"));
  errors.push(...validatePeerAddress(envelope.target, "target"));
  if (!nonEmptyString(envelope.timestamp) || Number.isNaN(Date.parse(envelope.timestamp))) errors.push("timestamp must be an ISO-like string");
  if (envelope.correlationId !== undefined && !nonEmptyString(envelope.correlationId)) errors.push("correlationId must be a non-empty string when present");
  if (envelope.causationId !== undefined && !nonEmptyString(envelope.causationId)) errors.push("causationId must be a non-empty string when present");
  if (!Number.isInteger(envelope.hopCount) || envelope.hopCount < 0) errors.push("hopCount must be a non-negative integer");
  if (!Number.isInteger(envelope.maxHopCount) || envelope.maxHopCount < 0) errors.push("maxHopCount must be a non-negative integer");
  if (Number.isInteger(envelope.hopCount) && Number.isInteger(envelope.maxHopCount) && envelope.hopCount > envelope.maxHopCount) {
    errors.push("hopCount must not exceed maxHopCount");
  }
  errors.push(...validatePeerAuth(envelope.auth));
  if (!("body" in envelope)) errors.push("body is required");

  return { ok: errors.length === 0, errors };
}

export function assertValidPeerEnvelope(envelope) {
  const validation = validatePeerEnvelope(envelope);
  if (!validation.ok) {
    const error = new Error(`Invalid Pi peer envelope: ${validation.errors.join("; ")}`);
    error.code = "PI_PEER_INVALID_ENVELOPE";
    error.errors = validation.errors;
    throw error;
  }
  return envelope;
}

export function createPeerEnvelope({
  type,
  id = createPeerId(type && type.startsWith("message.") ? "msg" : "evt"),
  conversationId = createPeerId("conv"),
  source,
  target,
  timestamp = new Date().toISOString(),
  correlationId,
  causationId,
  hopCount = 0,
  maxHopCount = 1,
  auth,
  audit,
  body = {},
}) {
  const envelope = {
    protocol: PEER_PROTOCOL,
    version: PEER_VERSION,
    type,
    id,
    conversationId,
    source,
    target,
    timestamp,
    hopCount,
    maxHopCount,
    body,
  };
  if (auth !== undefined) envelope.auth = auth;
  if (correlationId !== undefined) envelope.correlationId = correlationId;
  if (causationId !== undefined) envelope.causationId = causationId;
  if (audit !== undefined) envelope.audit = audit;
  return assertValidPeerEnvelope(envelope);
}

export function resolvePeerAuthToken(source = {}, options = {}) {
  const env = options.env || process.env || {};
  if (nonEmptyString(source.authToken)) return source.authToken;
  if (nonEmptyString(source.authTokenEnv)) {
    const token = env[source.authTokenEnv];
    return nonEmptyString(token) ? token : undefined;
  }
  return undefined;
}

export function createPeerEnvelopeAuth(source = {}, options = {}) {
  const token = resolvePeerAuthToken(source, options);
  return token ? { type: PEER_AUTH_TYPE_SHARED_TOKEN, token } : undefined;
}

export function attachPeerEnvelopeAuth(envelope, source = {}, options = {}) {
  const auth = createPeerEnvelopeAuth(source, options);
  return auth ? assertValidPeerEnvelope({ ...envelope, auth }) : envelope;
}

export function normalizePeerAddress(address, fallback = {}) {
  const merged = { ...fallback, ...(address && typeof address === "object" ? address : {}) };
  if (!nonEmptyString(merged.peerId)) throw new Error("peer address requires peerId");
  return {
    peerId: merged.peerId,
    ...(nonEmptyString(merged.sessionId) ? { sessionId: merged.sessionId } : {}),
    ...(nonEmptyString(merged.sessionFile) ? { sessionFile: merged.sessionFile } : {}),
    ...(nonEmptyString(merged.cwd) ? { cwd: merged.cwd } : {}),
    ...(nonEmptyString(merged.role) ? { role: merged.role } : {}),
    ...(nonEmptyString(merged.transport) ? { transport: merged.transport } : {}),
  };
}

export function normalizePeerMessageSendBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("peer message body must be an object");
  if (!nonEmptyString(body.prompt)) throw new Error("peer message prompt must be a non-empty string");
  return {
    ...body,
    prompt: body.prompt,
    intent: body.intent || "ask",
    contextRefs: Array.isArray(body.contextRefs) ? body.contextRefs : [],
    delivery: {
      intoReceiverTurn: true,
      responseMode: "final-assistant-message",
      ...(body.delivery && typeof body.delivery === "object" ? body.delivery : {}),
    },
  };
}

export function normalizePeerMessageResponseBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      status: "ERROR",
      summary: "Peer transport returned an invalid response body",
      ...finalAssistantTextMetadata(),
    };
  }
  const status = ["OK", "OK_WITH_NOTES", "NEEDS_CONTEXT", "BLOCKED", "CANCELLED", "ERROR"].includes(body.status) ? body.status : "OK";
  return { ...body, status, ...finalAssistantTextMetadata(body.finalAssistantMessage) };
}

export function finalAssistantTextMetadata(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return {
    finalAssistantTextPresent: text.length > 0,
    finalAssistantTextLength: text.length,
  };
}

export function redactPeerAuditValue(value, options = {}) {
  const homeDir = typeof options.homeDir === "string" && options.homeDir ? options.homeDir.replace(/\/+$/, "") : "";
  return redactValue(value, homeDir, "");
}

function validatePeerAddress(address, label) {
  const errors = [];
  if (!address || typeof address !== "object" || Array.isArray(address)) return [`${label} must be an object`];
  if (!nonEmptyString(address.peerId)) errors.push(`${label}.peerId must be a non-empty string`);
  for (const field of ["sessionId", "sessionFile", "cwd", "role", "transport"]) {
    if (address[field] !== undefined && !nonEmptyString(address[field])) errors.push(`${label}.${field} must be a non-empty string when present`);
  }
  return errors;
}

function validatePeerAuth(auth) {
  if (auth === undefined) return [];
  const errors = [];
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return ["auth must be an object when present"];
  if (auth.type !== PEER_AUTH_TYPE_SHARED_TOKEN) errors.push(`auth.type must be ${PEER_AUTH_TYPE_SHARED_TOKEN}`);
  if (!nonEmptyString(auth.token)) errors.push("auth.token must be a non-empty string");
  return errors;
}

function redactValue(value, homeDir, key) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value, homeDir);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, homeDir, key));
  if (typeof value !== "object") return String(value);

  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (isSensitiveEnvKey(childKey) || isEnvKey(childKey)) {
      out[childKey] = "[REDACTED_ENV]";
    } else if (isSensitiveKey(childKey)) {
      out[childKey] = "[REDACTED]";
    } else {
      out[childKey] = redactValue(childValue, homeDir, childKey);
    }
  }
  return out;
}

function redactString(input, homeDir) {
  let text = input;
  if (homeDir) text = text.split(homeDir).join("~");
  return text
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_TOKEN]")
    .replace(/sk-[A-Za-z0-9][A-Za-z0-9_-]{9,}/g, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(token|secret|password|api[_-]?key)=([^\s&]+)/gi, "$1=[REDACTED]");
}

function isSensitiveKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[-_]/g, "");
  return normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("credential")
    || normalized.includes("authorization")
    || normalized.includes("apikey")
    || normalized === "auth"
    || normalized.endsWith("auth");
}

function isEnvKey(key) {
  return /^env(ironment)?$/i.test(key);
}

function isSensitiveEnvKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[-_]/g, "");
  return normalized.endsWith("tokenenv") || normalized.endsWith("secretenv") || normalized.endsWith("credentialenv");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function createPeerId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}
