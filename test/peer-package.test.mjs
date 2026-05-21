import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const publishSkill = await readFile(new URL("../skills/pi-peer-publish/SKILL.md", import.meta.url), "utf8");
const extensionSource = await readFile(new URL("../extensions/pi-peer/index.ts", import.meta.url), "utf8");

test("package publishes bundled skills", () => {
  assert.ok(packageJson.files.includes("skills"));
  assert.deepEqual(packageJson.pi.skills, ["skills"]);
});

test("publish npm skill has required frontmatter and safety gates", () => {
  assert.match(publishSkill, /^---\nname: pi-peer-publish\n/m);
  assert.match(publishSkill, /^description: .+@cryptolibertus\/pi-peer.+npm/m);
  assert.match(publishSkill, /Stop before `npm publish` unless the user has explicitly asked to publish now/);
  assert.match(publishSkill, /npm publish --access public/);
  assert.match(publishSkill, /npm view @cryptolibertus\/pi-peer version/);
});

test("fanout send does not create a separate dispatching placeholder task", () => {
  assert.doesNotMatch(extensionSource, /status:\s*parsed\.send\s*\?\s*["']dispatching["']\s*:\s*["']planned["']/);
  assert.match(extensionSource, /if \(!parsed\.send\) \{[\s\S]*status: "planned"/);
  assert.match(extensionSource, /recordPeerSendGoalDispatch/);
});
