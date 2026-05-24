import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TOOL_REGISTRY,
  deriveToolsetForRole,
  initToolRegistry,
  loadToolRegistry,
  toolAllowedForRole,
} from "../src/peers/tool-registry.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-tools-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("tool registry initializes without yaml dependency", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initToolRegistry(root);
    assert.equal(result.created.length, 1);

    const registry = await loadToolRegistry(root);
    assert.equal(registry.version, 1);
    assert.equal(registry.tools.some((tool) => tool.id === "peer_send"), true);
  });
});

test("tool registry derives role-specific curated tools", () => {
  const toolset = deriveToolsetForRole(DEFAULT_TOOL_REGISTRY, {
    role: "reviewer",
    domain: "protocol",
  });

  assert.equal(toolset.some((tool) => tool.id === "peer_get"), true);
  assert.equal(toolAllowedForRole(DEFAULT_TOOL_REGISTRY, "peer_send", "reviewer"), true);
});
