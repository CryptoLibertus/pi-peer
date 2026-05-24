import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TOOL_REGISTRY,
  TOOL_REGISTRY_FILE,
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

test("tool registry init preserves existing registry unless overwrite is true", async (t) => {
  await withRoot(t, async (root) => {
    await initToolRegistry(root);
    const file = join(root, TOOL_REGISTRY_FILE);
    const custom = JSON.stringify({ version: 1, tools: [{ id: "custom", roles: ["reviewer"] }] });
    await writeFile(file, custom, "utf8");

    const preserved = await initToolRegistry(root);
    assert.deepEqual(preserved, { created: [], existing: [TOOL_REGISTRY_FILE] });
    assert.equal(await readFile(file, "utf8"), custom);

    const overwritten = await initToolRegistry(root, { overwrite: true });
    assert.deepEqual(overwritten, { created: [TOOL_REGISTRY_FILE], existing: [] });
    const registry = await loadToolRegistry(root);
    assert.equal(registry.tools.some((tool) => tool.id === "peer_send"), true);
  });
});

test("corrupt tool registry load throws clear error", async (t) => {
  await withRoot(t, async (root) => {
    await mkdir(join(root, ".pi/tools"), { recursive: true });
    await writeFile(join(root, TOOL_REGISTRY_FILE), "{not-json", "utf8");

    await assert.rejects(
      () => loadToolRegistry(root),
      /corrupt peer tool registry:/,
    );
  });
});

test("tool registry denies implementer peer_send", () => {
  assert.equal(toolAllowedForRole(DEFAULT_TOOL_REGISTRY, "peer_send", "implementer"), false);
});

test("tool registry does not treat domain as role permission", () => {
  const toolset = deriveToolsetForRole(DEFAULT_TOOL_REGISTRY, { domain: "reviewer" });
  assert.equal(toolset.some((tool) => tool.id === "peer_send"), false);
});

test("tool registry normalizes malformed tool fields", () => {
  const toolset = deriveToolsetForRole({
    version: 1,
    tools: [
      {
        id: " custom_review ",
        risk: " medium ",
        roles: [" reviewer ", "", null],
        permissions: [" delegate-peer-task ", 42, ""],
        failureModes: [" duplicate-work ", undefined],
      },
      { id: "", roles: ["reviewer"] },
      { id: 42, roles: ["reviewer"] },
    ],
  }, { role: "reviewer" });

  assert.deepEqual(toolset, [{
    id: "custom_review",
    risk: "medium",
    roles: ["reviewer"],
    permissions: ["delegate-peer-task", "42"],
    failureModes: ["duplicate-work"],
  }]);
});
