import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const TOOL_REGISTRY_DIR = ".pi/tools";
export const TOOL_REGISTRY_FILE = `${TOOL_REGISTRY_DIR}/registry.json`;

export const DEFAULT_TOOL_REGISTRY = Object.freeze({
  version: 1,
  tools: Object.freeze([
    Object.freeze({
      id: "peer_list",
      risk: "low",
      roles: Object.freeze(["planner", "coordinator", "reviewer", "researcher", "implementer"]),
      permissions: Object.freeze(["read-peer-state"]),
      failureModes: Object.freeze(["stale-discovery"]),
    }),
    Object.freeze({
      id: "peer_send",
      risk: "medium",
      roles: Object.freeze(["planner", "coordinator", "reviewer"]),
      permissions: Object.freeze(["delegate-peer-task"]),
      failureModes: Object.freeze(["duplicate-work", "stale-task", "unavailable-peer"]),
    }),
    Object.freeze({
      id: "peer_get",
      risk: "low",
      roles: Object.freeze(["planner", "coordinator", "reviewer", "researcher", "implementer"]),
      permissions: Object.freeze(["read-peer-state"]),
      failureModes: Object.freeze(["large-context"]),
    }),
    Object.freeze({
      id: "peer_progress",
      risk: "low",
      roles: Object.freeze(["planner", "coordinator", "reviewer", "researcher", "implementer"]),
      permissions: Object.freeze(["report-progress"]),
      failureModes: Object.freeze(["missing-inbound-task"]),
    }),
  ]),
});

export async function initToolRegistry(root, options = {}) {
  const file = registryPath(root);
  await mkdir(dirname(file), { recursive: true });

  if (!options.overwrite) {
    const existing = await readFile(file, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined) return { created: [], existing: [TOOL_REGISTRY_FILE] };
  }

  await writeFile(file, `${JSON.stringify(DEFAULT_TOOL_REGISTRY, null, 2)}\n`, "utf8");
  return { created: [TOOL_REGISTRY_FILE], existing: [] };
}

export async function loadToolRegistry(root) {
  let text;
  try {
    text = await readFile(registryPath(root), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return DEFAULT_TOOL_REGISTRY;
    throw error;
  }

  try {
    const registry = JSON.parse(text);
    return normalizeRegistry(registry);
  } catch (error) {
    throw new Error(`corrupt peer tool registry: ${errorMessage(error)}`);
  }
}

export function deriveToolsetForRole(registry, input = {}) {
  const source = normalizeRegistry(registry || DEFAULT_TOOL_REGISTRY);
  const roleNames = rolesForInput(input);
  if (roleNames.length === 0) return [];
  return source.tools.filter((tool) => {
    const toolRoles = Array.isArray(tool.roles) ? tool.roles.map(cleanKey).filter(Boolean) : [];
    return roleNames.some((role) => toolRoles.includes(role));
  });
}

export function toolAllowedForRole(registry, toolId, role) {
  const id = cleanText(toolId);
  if (!id) return false;
  return deriveToolsetForRole(registry, { role }).some((tool) => tool.id === id);
}

export function formatToolRegistryStatus(registry = {}) {
  const source = normalizeRegistry(Array.isArray(registry?.tools) ? registry : DEFAULT_TOOL_REGISTRY);
  const counts = new Map();
  for (const tool of source.tools) {
    const risk = cleanKey(tool.risk) || "unknown";
    counts.set(risk, (counts.get(risk) || 0) + 1);
  }
  const riskText = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([risk, count]) => `${risk}:${count}`)
    .join(" ");
  return `Tool registry v${source.version || "unknown"} · ${source.tools.length} tools${riskText ? ` · ${riskText}` : ""}`;
}

function normalizeRegistry(registry = {}) {
  const tools = Array.isArray(registry.tools) ? registry.tools.filter((tool) => tool && typeof tool === "object") : [];
  return {
    ...registry,
    version: registry.version || DEFAULT_TOOL_REGISTRY.version,
    tools,
  };
}

function rolesForInput(input = {}) {
  const rawRoles = [
    input.role,
    input.parentPeerRole,
    input.peerRole,
    input.domain,
  ];
  return [...new Set(rawRoles.flatMap(roleAliases).filter(Boolean))];
}

function roleAliases(value) {
  const role = cleanKey(value);
  if (!role) return [];
  if (role === "worker") return ["implementer"];
  if (role === "coordinator") return ["coordinator", "planner"];
  if (role === "lead") return ["planner", "coordinator"];
  return [role];
}

function registryPath(root) {
  return join(root || ".", TOOL_REGISTRY_FILE);
}

function errorMessage(error) {
  return cleanText(error?.message || error) || "unknown error";
}

function cleanKey(value) {
  return cleanText(value).toLowerCase();
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
