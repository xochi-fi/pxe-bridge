/**
 * The RECIPIENT side of the spike: a standard @aztec/accounts SchnorrAccount
 * in its own process, its own EmbeddedWallet/PXE and its own data directory.
 * Its secrets are generated here and never leave `<state>/recipient/`.
 *
 *   npx tsx spike/633-recipient-schnorr/recipient.ts create
 *   npx tsx spike/633-recipient-schnorr/recipient.ts deploy
 *   npx tsx spike/633-recipient-schnorr/recipient.ts receive
 *   npx tsx spike/633-recipient-schnorr/recipient.ts spend <amount>
 *   npx tsx spike/633-recipient-schnorr/recipient.ts sign
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SchnorrAccountContractArtifact } from "@aztec/accounts/schnorr";
import { NO_FROM } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { keccak256 } from "@aztec/foundation/crypto/keccak";
import { Schnorr, SchnorrSignature } from "@aztec/foundation/crypto/schnorr";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";
import { TxHash } from "@aztec/stdlib/tx";

import {
  assertEq,
  assertTxSucceeded,
  json,
  NODE_URL,
  openWallet,
  partyDir,
  readPublic,
  simulateFee,
  sponsoredFee,
  writePublic,
} from "./common.js";

const cmd = process.argv[2];
const secretFile = join(partyDir("recipient"), "secret.json");

if (cmd === "create") {
  if (existsSync(secretFile)) throw new Error(`${secretFile} exists; refusing to overwrite keys`);
  // Generated locally, kept locally (0600). Nothing below writes them anywhere else.
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
const manager = await wallet.createSchnorrAccount(
  Fr.fromString(keys.secret),
  Fr.fromString(keys.salt),
  signingKey,
);
const me = manager.address;
const node = createAztecNodeClient(NODE_URL);
console.log(`[recipient] address ${me.toString()}`);
const pub = readPublic();

switch (cmd) {
  case "create": {
    // The public descriptor: everything a verifier needs to re-derive the
    // address, and nothing that grants spending or viewing.
    const instance = manager.getInstance();
    const signingPublicKey = await new Schnorr().computePublicKey(signingKey);
    const cls = await getContractClassFromArtifact(SchnorrAccountContractArtifact);
    const descriptor = {
      accountClass: "@aztec/accounts SchnorrAccount",
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
    console.log(
      `[recipient] instance.originalContractClassId ${instance.originalContractClassId.toString()}`,
    );
    writePublic({ recipientAddress: me.toString(), recipientDescriptor: descriptor });
    break;
  }
  case "deploy": {
    console.log(`[recipient] on node before deploy: ${(await node.getContract(me)) !== undefined}`);
    const deploy = await manager.getDeployMethod();
    const { receipt } = await deploy.send({
      from: NO_FROM,
      fee: await sponsoredFee(wallet),
      skipClassPublication: false,
      skipInstancePublication: false,
    });
    console.log(`[recipient] deploy tx ${receipt.txHash.toString()} status ${receipt.status}`);
    assertTxSucceeded("[recipient] deploy tx", receipt);
    writePublic({ recipientDeployTx: receipt.txHash.toString() });
    // Finality (proven, then L1 mined, then finalized) is finality.ts's job;
    // run.sh runs it on this tx next and fails the run if it never finalizes.
    break;
  }
  case "receive": {
    // Discovery inputs: the token artifact + its published instance, and the
    // sender registered as a tagging source. No sender/bridge state is read.
    const sender = AztecAddress.fromStringUnsafe(String(pub["sender"]));
    const tokenAddress = AztecAddress.fromStringUnsafe(String(pub["token"]));
    const instance = await node.getContract(tokenAddress);
    if (!instance) throw new Error("token not published");
    await wallet.registerContract(instance, TokenContract.artifact);
    await wallet.registerSender(sender, "sender");
    const token = TokenContract.at(tokenAddress, wallet);
    const { result } = await token.methods
      .balance_of_private(me)
      .simulate({ from: me, fee: await simulateFee() });
    assertEq("[recipient] private balance == paidAmount", result, pub["paidAmount"]);
    const r = await node.getTxReceipt(TxHash.fromString(String(pub["payTxHash"])));
    assertTxSucceeded(`[recipient] pay tx ${pub["payTxHash"]} (node receipt)`, r);
    break;
  }
  case "spend": {
    const amount = BigInt(process.argv[3] ?? "1");
    const sender = AztecAddress.fromStringUnsafe(String(pub["sender"]));
    const tokenAddress = AztecAddress.fromStringUnsafe(String(pub["token"]));
    const instance = await node.getContract(tokenAddress);
    if (!instance) throw new Error("token not published");
    await wallet.registerContract(instance, TokenContract.artifact);
    const token = TokenContract.at(tokenAddress, wallet);
    const before = (
      await token.methods.balance_of_private(me).simulate({ from: me, fee: await simulateFee() })
    ).result;
    // A private-to-private transfer back to the sender: the recipient proves it
    // in its own PXE and pays its own fee (SponsoredFPC in the sandbox).
    const { receipt } = await token.methods
      .transfer(sender, amount)
      .send({ from: me, fee: await sponsoredFee(wallet) });
    const after = (
      await token.methods.balance_of_private(me).simulate({ from: me, fee: await simulateFee() })
    ).result;
    console.log(`[recipient] spend tx ${receipt.txHash.toString()}`);
    assertTxSucceeded("[recipient] spend tx", receipt);
    assertEq(`[recipient] private balance delta (${before} -> ${after}) == spend amount`, before - after, amount);
    writePublic({ spendTxHash: receipt.txHash.toString(), spentAmount: amount.toString() });
    break;
  }
  case "sign": {
    // Stand-in for the binding digest: a 32-byte keccak256 value, as an EIP-712
    // digest would be. PROVISIONAL reduction into the Grumpkin base field (=
    // BN254 Fr): interpret big-endian and reduce mod r (Fr.fromBufferReduce).
    // A second, fixed digest above the modulus exercises the reduction.
    const provider = manager
      .getAccountContract()
      .getAuthWitnessProvider(await manager.getCompleteAddress());
    const signingPublicKey = await new Schnorr().computePublicKey(signingKey);
    const vectors = [];
    for (const digest of [
      keccak256(Buffer.from(`xochi#633 spike binding ${me.toString()}`)),
      Buffer.alloc(32, 0xff),
    ]) {
      const messageField = Fr.fromBufferReduce(digest);
      // Signed through the account's OWN auth-witness provider: the code path
      // that authorizes this account's transactions.
      const witness = await provider.createAuthWit(messageField);
      const [sLo, sHi, eLo, eHi] = witness.witness.map((f) => f.toBigInt());
      const s = (sHi! << 128n) | sLo!;
      const e = (eHi! << 128n) | eLo!;
      const sig = Buffer.concat([
        Buffer.from(s.toString(16).padStart(64, "0"), "hex"),
        Buffer.from(e.toString(16).padStart(64, "0"), "hex"),
      ]);
      // In-SDK reference check (bb.js), for comparison with the standalone one.
      const ok = await new Schnorr().verifySignature(
        messageField,
        signingPublicKey,
        new SchnorrSignature(sig),
      );
      console.log(
        `[recipient] digest 0x${digest.toString("hex")} -> field ${messageField.toString()} ` +
          `sig 0x${sig.toString("hex")} bb.js verify=${ok}`,
      );
      vectors.push({
        digest: `0x${digest.toString("hex")}`,
        messageField: messageField.toString(),
        signature: `0x${sig.toString("hex")}`,
      });
    }
    writePublic({ recipientSignatures: vectors });
    break;
  }
  default:
    throw new Error(`unknown command ${cmd}`);
}
process.exit(0);
