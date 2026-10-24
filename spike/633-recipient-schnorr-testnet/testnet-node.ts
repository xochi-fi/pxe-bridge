/**
 * Read-only facts about the network under test, before anything is sent:
 *
 *   - the node's self-reported version, L1 chain id and rollup version equal
 *     the documented public testnet and the SDK this directory pins;
 *   - the SponsoredFPC the 6.0.0 SDK derives is the documented address, is
 *     published on the node, and its on-chain class recomputes from the
 *     6.0.0 artifact (so the SDK and the network agree on class ids at all);
 *   - whether the node already has a class record for the pinned 6.0.0
 *     SchnorrAccount class id, and for the 5.2.0 and 6.0.0-rc.3 ids of the
 *     same class (with the L2 block the node says each was published in).
 *     Logged and written to public.json, not required: a private-only
 *     account never needs its class published, and recipient.ts deploy
 *     publishes the 6.0.0 one if absent.
 *
 *   npx tsx spike/633-recipient-schnorr-testnet/testnet-node.ts
 */
import { SchnorrAccountContractArtifact } from "@aztec-labs/accounts/schnorr";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";

import { assertEq, bounded, classRecordBlock, NODE_URL, nodeClient, sponsoredFpcInstance, writePublic } from "./common.js";
import * as pin from "./expected.js";

const node = nodeClient();
console.log(`node ${NODE_URL}`);

const info = await bounded("getNodeInfo", node.getNodeInfo());
assertEq("node reported version", info.nodeVersion, pin.TESTNET_NODE_VERSION);
assertEq("node reported version == pinned SDK version", info.nodeVersion, pin.AZTEC_VERSION);
assertEq("node L1 chain id", info.l1ChainId, pin.TESTNET_L1_CHAIN_ID);
assertEq("node rollup version", info.rollupVersion, pin.TESTNET_ROLLUP_VERSION);
console.log(`node rollup address ${info.l1ContractAddresses.rollupAddress.toString()}`);

const tips = await bounded("getChainTips", node.getChainTips());
console.log(
  `chain tips proposed=${tips.proposed.number} checkpointed=${tips.checkpointed.block.number} ` +
    `proven=${tips.proven.block.number} finalized=${tips.finalized.block.number}`,
);

const fpc = await sponsoredFpcInstance();
const fpcOnNode = await bounded("getContract(SponsoredFPC)", node.getContract(fpc.address));
assertEq("SponsoredFPC instance published on node", fpcOnNode !== undefined, true);
const fpcClass = await getContractClassFromArtifact(SponsoredFPCContract.artifact);
assertEq("SponsoredFPC on-chain class id == 6.0.0 artifact class id", fpcOnNode!.currentContractClassId, fpcClass.id);

const schnorr = await getContractClassFromArtifact(SchnorrAccountContractArtifact);
assertEq("6.0.0 SchnorrAccount class id == pin", schnorr.id, pin.PINNED_CLASS_ID);
const before = await bounded("getContractClass(SchnorrAccount)", node.getContractClass(Fr.fromString(pin.PINNED_CLASS_ID)));
for (const [label, id] of [
  ["pinned 6.0.0", pin.PINNED_CLASS_ID],
  ["5.2.0 pin", pin.PIN_5_2_0_CLASS_ID],
  ["6.0.0-rc.3", pin.RC3_CLASS_ID],
] as const) {
  const block = await classRecordBlock(id);
  console.log(
    `node class record for the ${label} SchnorrAccount class ${id}: ${block === undefined ? "absent" : `present (l2BlockNumber ${block})`}`,
  );
}

writePublic({
  nodeVersion: info.nodeVersion,
  schnorrClassPublishedBeforeRun: before !== undefined,
  tipsAtStart: {
    proposed: tips.proposed.number,
    proven: tips.proven.block.number,
    finalized: tips.finalized.block.number,
  },
});
process.exit(0);
