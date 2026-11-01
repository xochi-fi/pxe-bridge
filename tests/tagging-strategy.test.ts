import { describe, expect, it } from "vitest";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { bridgeTaggingSecretStrategy } from "../src/aztec-client.js";

const BRIDGE = AztecAddress.fromBigIntUnsafe(0xb1n);
const RECIPIENT = AztecAddress.fromBigIntUnsafe(0x7en);
const TOKEN = AztecAddress.fromBigIntUnsafe(0x70n);

function request(deliveryMode: "constrained" | "unconstrained", recipient: AztecAddress) {
  return {
    contractAddress: TOKEN,
    contractClassId: Fr.ZERO,
    sender: BRIDGE,
    recipient,
    deliveryMode,
  };
}

describe("bridgeTaggingSecretStrategy", () => {
  it("tags a payout by the two addresses' keys, publishing no handshake", async () => {
    await expect(bridgeTaggingSecretStrategy(request("unconstrained", RECIPIENT))).resolves.toEqual({
      type: "address-derived",
    });
  });

  it("refuses constrained delivery to a recipient rather than reveal it", async () => {
    await expect(bridgeTaggingSecretStrategy(request("constrained", RECIPIENT))).rejects.toThrow(
      `Refusing constrained message delivery to ${RECIPIENT.toString()}`,
    );
  });

  it("keeps the default handshake only for constrained delivery to the bridge itself", async () => {
    await expect(bridgeTaggingSecretStrategy(request("constrained", BRIDGE))).resolves.toEqual({
      type: "non-interactive-handshake",
    });
  });
});
