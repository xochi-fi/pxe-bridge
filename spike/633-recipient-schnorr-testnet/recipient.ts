/**
 * The RECIPIENT side of the testnet spike: a stock @aztec-labs/accounts 6.0.0
 * SchnorrAccount in its own process, its own EmbeddedWallet/PXE (client-side
 * proving on) and its own data directory, against the public testnet node.
 * Its throwaway secrets are generated here and never leave
 * `<state>/recipient/` (0600); no funds ever reach the account.
 *
 *   npx tsx spike/633-recipient-schnorr-testnet/recipient.ts create
 *   npx tsx spike/633-recipient-schnorr-testnet/recipient.ts deploy
 *
 * The deploy pays through the testnet's documented SponsoredFPC and publishes
 * the class and the instance, so check-descriptor.ts can read both back.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SchnorrAccountContractArtifact } from "@aztec-labs/accounts/schnorr";
import { NO_FROM } from "@aztec-labs/aztec.js/account";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { Schnorr } from "@aztec-labs/foundation/crypto/schnorr";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";

import { assertEq, assertTxSucceeded, json, nodeClient, openWallet, partyDir, sponsoredFee, writePublic } from "./common.js";
import { PINNED_CLASS_ID } from "./expected.js";

const cmd = process.argv[2];
if (cmd !== "create" && cmd !== "deploy") throw new Error(`usage: recipient.ts create|deploy (got ${cmd})`);
const secretFile = join(partyDir("recipient"), "secret.json");

if (cmd === "create") {
  if (existsSync(secretFile)) throw new Error(`${secretFile} exists; refusing to overwrite keys`);
  writeFileSync(
    secretFile,
    json({
      secret: Fr.random().toString(),
      salt: Fr.random().toString(),
      signingKey: GrumpkinScalar.random().toString(),
    }),
    { mode: 0o600 },
  );
}
const keys = JSON.parse(readFileSync(secretFile, "utf8"));
const signingKey = GrumpkinScalar.fromString(keys.signingKey);

const wallet = await openWallet("recipient");
const manager = await wallet.createSchnorrAccount(Fr.fromString(keys.secret), Fr.fromString(keys.salt), signingKey);
const me = manager.address;
const node = nodeClient();
console.log(`[recipient] address ${me.toString()}`);

if (cmd === "create") {
  // The public descriptor: everything a verifier needs to re-derive the
  // address, and nothing that grants spending or viewing.
  const instance = manager.getInstance();
  const signingPublicKey = await new Schnorr().computePublicKey(signingKey);
  const cls = await getContractClassFromArtifact(SchnorrAccountContractArtifact);
  assertEq("[recipient] wallet instance originalContractClassId == pin", instance.originalContractClassId, PINNED_CLASS_ID);
  const descriptor = {
    accountClass: "@aztec-labs/accounts SchnorrAccount",
    classId: cls.id.toString(),
    artifactHash: cls.artifactHash.toString(),
    constructor: "constructor",
    constructorArgs: [signingPublicKey.x.toString(), signingPublicKey.y.toString()],
    initializationHash: instance.initializationHash.toString(),
    salt: instance.salt.toString(),
    deployer: instance.deployer.toString(),
    immutablesHash: instance.immutablesHash.toString(),
    publicKeys: instance.publicKeys.toString(),
    address: me.toString(),
  };
  console.log(`[recipient] descriptor ${json(descriptor)}`);
  writePublic({ recipientAddress: me.toString(), recipientDescriptor: descriptor });
} else {
  assertEq("[recipient] instance on node before deploy", (await node.getContract(me)) !== undefined, false);
  const deploy = await manager.getDeployMethod();
  const started = Date.now();
  const { receipt } = await deploy.send({
    from: NO_FROM,
    fee: await sponsoredFee(wallet),
    skipClassPublication: false,
    skipInstancePublication: false,
    wait: { timeout: 900 },
  });
  console.log(
    `[recipient] deploy tx ${receipt.txHash.toString()} status ${receipt.status} block ${receipt.blockNumber} ` +
      `fee ${receipt.transactionFee} (${Math.round((Date.now() - started) / 1000)}s incl. client proving)`,
  );
  assertTxSucceeded("[recipient] deploy tx", receipt);
  writePublic({ recipientDeployTx: receipt.txHash.toString(), recipientDeployBlock: Number(receipt.blockNumber) });
  // Finality is finality.ts's job; run.sh runs it on this tx next.
}
process.exit(0);
