import test from "node:test";
import assert from "node:assert/strict";

import { PEER_ORG_INIT_ID_ERROR, resolvePeerOrgInitPeerId } from "../src/peers/org.mjs";

test("resolvePeerOrgInitPeerId prefers explicit parsed id over generated runtime identity", () => {
  const peerId = resolvePeerOrgInitPeerId(
    { localPeerId: "planner-a" },
    { localPeerId: "runtime-peer", summary: { localPeerIdSource: "generated" } },
  );

  assert.equal(peerId, "planner-a");
});

test("resolvePeerOrgInitPeerId rejects generated or missing runtime identity source", () => {
  for (const runtime of [
    { localPeerId: "runtime-peer", summary: { localPeerIdSource: "generated" } },
    { localPeerId: "runtime-peer" },
  ]) {
    assert.throws(
      () => resolvePeerOrgInitPeerId({}, runtime),
      { message: PEER_ORG_INIT_ID_ERROR },
    );
  }
});

test("resolvePeerOrgInitPeerId accepts stable runtime identities", () => {
  assert.equal(
    resolvePeerOrgInitPeerId({}, { localPeerId: "planner-json", summary: { localPeerIdSource: ".pi/peers.json:localPeerId" } }),
    "planner-json",
  );
  assert.equal(
    resolvePeerOrgInitPeerId({}, { summary: { localPeerId: "planner-env" }, config: { localPeerIdSource: "PI_PEER_ID" } }),
    "planner-env",
  );
});
