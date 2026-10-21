/**
 * The SENDER side of the spike: a separate account in a separate process and
 * PXE, standing in for whatever pays the recipient (in production, the bridge's
 * solver account). It deploys a test token, funds itself publicly, and pays the
 * recipient with transfer_to_private.
 *
 *   npx tsx spike/633-recipient-schnorr/sender.ts setup
 *   npx tsx spike/633-recipient-schnorr/sender.ts pay <amount>
 *   npx tsx spike/633-recipient-schnorr/sender.ts balance
 *   npx tsx spike/633-recipient-schnorr/sender.ts tick        # one cheap tx, to drive a block
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NO_FROM } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { TokenContract } from "@aztec/noir-contracts.js/Token";

import {
  assertEq,
  assertTxSucceeded,
  json,
  openWallet,
  partyDir,
  readPublic,
  simulateFee,
  sponsoredFee,
  writePublic,
} from "./common.js";

const cmd = process.argv[2];
const secretFile = join(partyDir("sender"), "secret.json");

if (cmd === "setup" && !existsSync(secretFile)) {
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

const wallet = await openWallet("sender");
const manager = await wallet.createSchnorrAccount(
  Fr.fromString(keys.secret),
  Fr.fromString(keys.salt),
  GrumpkinScalar.fromString(keys.signingKey),
);
const me = manager.address;
console.log(`[sender] address ${me.toString()}`);

const pub = readPublic();

switch (cmd) {
  case "setup": {
    const deploy = await manager.getDeployMethod();
    await deploy.send({
      from: NO_FROM,
      fee: await sponsoredFee(wallet),
      skipClassPublication: false,
      skipInstancePublication: false,
    });
    console.log("[sender] account deployed");

    const { contract } = await TokenContract.deploy(wallet, me, "Spike633", "S633", 18).send({
      from: me,
      fee: await sponsoredFee(wallet),
    });
    console.log(`[sender] token ${contract.address.toString()}`);
    const minted = 1_000_000n;
    await contract.methods.mint_to_public(me, minted).send({ from: me, fee: await sponsoredFee(wallet) });
    console.log(`[sender] minted ${minted} to own public balance`);
    writePublic({
      sender: me.toString(),
      token: contract.address.toString(),
      mintedAmount: minted.toString(),
    });
    break;
  }
  case "pay": {
    const amount = BigInt(process.argv[3] ?? "1000");
    const recipient = AztecAddress.fromStringUnsafe(String(pub["recipientAddress"]));
    const token = TokenContract.at(AztecAddress.fromStringUnsafe(String(pub["token"])), wallet);
    const result = await token.methods
      .transfer_to_private(recipient, amount)
      .send({ from: me, fee: await sponsoredFee(wallet) });
    console.log(`[sender] transfer_to_private(${recipient.toString()}, ${amount}) receipt:`);
    console.log(json(result.receipt));
    assertTxSucceeded("[sender] pay tx", result.receipt);
    writePublic({ paidAmount: amount.toString(), payTxHash: result.receipt.txHash.toString() });
    break;
  }
  case "balance": {
    const token = TokenContract.at(AztecAddress.fromStringUnsafe(String(pub["token"])), wallet);
    const opts = { from: me, fee: await simulateFee() };
    const { result: priv } = await token.methods.balance_of_private(me).simulate(opts);
    const { result: pubBal } = await token.methods.balance_of_public(me).simulate(opts);
    // The sender starts with only its public mint; it pays `paidAmount` out of
    // public into the recipient's private balance, and gets `spentAmount` back
    // privately from the recipient.
    const minted = BigInt(String(pub["mintedAmount"]));
    const paid = BigInt(String(pub["paidAmount"]));
    const spent = BigInt(String(pub["spentAmount"]));
    assertEq("[sender] private balance == spentAmount", priv, spent);
    assertEq("[sender] public balance == mintedAmount - paidAmount", pubBal, minted - paid);
    break;
  }
  case "tick": {
    const token = TokenContract.at(AztecAddress.fromStringUnsafe(String(pub["token"])), wallet);
    await token.methods.mint_to_public(me, 1n).send({ from: me, fee: await sponsoredFee(wallet) });
    console.log("[sender] tick");
    break;
  }
  default:
    throw new Error(`unknown command ${cmd}`);
}
process.exit(0);
