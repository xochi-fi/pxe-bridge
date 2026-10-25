import { describe, it, expect } from "vitest";
import { SchnorrAccountContractArtifact } from "@aztec-labs/accounts/schnorr";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import {
  ACCOUNT_ADDRESS_ENV,
  ALLOW_ACCOUNT_DEPLOY_ENV,
  SCHNORR_CLASS_ID_5_1_0,
  SCHNORR_CLASS_ID_5_2_0,
  SCHNORR_CLASS_ID_6_0_0,
  assertAccountIdentity,
  resolveAccountIdentityConfig,
} from "../src/account-identity.js";

const RECORDED = "0x" + "1a".repeat(32);
const DERIVED = "0x" + "2b".repeat(32);

describe("resolveAccountIdentityConfig", () => {
  it("refuses a production start with no recorded address and no deploy flag", () => {
    // The upgrade path this exists for: nothing set, so the bridge would run as
    // whatever its key now derives to.
    expect(() => resolveAccountIdentityConfig({ NODE_ENV: "production" })).toThrow(
      new RegExp(`${ACCOUNT_ADDRESS_ENV} is required when NODE_ENV=production`),
    );
  });

  it("lets a production first deployment start under the deploy flag", () => {
    expect(
      resolveAccountIdentityConfig({ NODE_ENV: "production", [ALLOW_ACCOUNT_DEPLOY_ENV]: "1" }),
    ).toEqual({ allowDeploy: true });
  });

  it("takes only `1` as the deploy flag", () => {
    expect(() =>
      resolveAccountIdentityConfig({ NODE_ENV: "production", [ALLOW_ACCOUNT_DEPLOY_ENV]: "true" }),
    ).toThrow(/is required when NODE_ENV=production/);
  });

  it("returns the recorded address in production", () => {
    expect(
      resolveAccountIdentityConfig({ NODE_ENV: "production", [ACCOUNT_ADDRESS_ENV]: RECORDED }),
    ).toEqual({ expectedAddress: RECORDED, allowDeploy: false });
  });

  it("does not require a recorded address outside production", () => {
    expect(resolveAccountIdentityConfig({ NODE_ENV: "development" })).toEqual({
      allowDeploy: false,
    });
  });

  it("rejects a malformed recorded address", () => {
    expect(() => resolveAccountIdentityConfig({ [ACCOUNT_ADDRESS_ENV]: "0x1234" })).toThrow(
      /must be a 32-byte hex AztecAddress/,
    );
  });

  it("rejects a set-but-empty recorded address rather than reading it as unset", () => {
    expect(() =>
      resolveAccountIdentityConfig({ NODE_ENV: "development", [ACCOUNT_ADDRESS_ENV]: "" }),
    ).toThrow(new RegExp(`${ACCOUNT_ADDRESS_ENV} is set but empty`));
  });

  it("rejects a zero recorded address", () => {
    expect(() =>
      resolveAccountIdentityConfig({ [ACCOUNT_ADDRESS_ENV]: "0x" + "0".repeat(64) }),
    ).toThrow(/must not be the zero address/);
  });
});

describe("assertAccountIdentity", () => {
  const check = (derived: string, expected: string) =>
    assertAccountIdentity({
      role: "Bridge account",
      derived,
      derivedClassId: SCHNORR_CLASS_ID_6_0_0,
      expected,
      expectedSource: ACCOUNT_ADDRESS_ENV,
    });

  it("accepts the recorded address", () => {
    expect(() => check(RECORDED, RECORDED)).not.toThrow();
  });

  it("accepts the recorded address in either hex case", () => {
    expect(() => check(RECORDED, RECORDED.toUpperCase().replace("0X", "0x"))).not.toThrow();
  });

  it("refuses a derived address that is not the recorded one, naming both and the class", () => {
    let message = "";
    try {
      check(DERIVED, RECORDED);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`Bridge account derives to ${DERIVED}`);
    expect(message).toContain(`${ACCOUNT_ADDRESS_ENV} is ${RECORDED}`);
    expect(message).toContain(`contract class ${SCHNORR_CLASS_ID_6_0_0}`);
    expect(message).toContain(SCHNORR_CLASS_ID_5_2_0);
    expect(message).toContain(SCHNORR_CLASS_ID_5_1_0);
    expect(message).toMatch(/Refusing to use, deploy or sign/);
  });

  it("refuses a mismatch under a class it does not recognise, blaming the constructor inputs", () => {
    // A derived class that is not this runtime's stock SchnorrAccount (here the
    // superseded 5.2.0 one) is still refused; only the explanation changes.
    let message = "";
    try {
      assertAccountIdentity({
        role: "Bridge account",
        derived: DERIVED,
        derivedClassId: SCHNORR_CLASS_ID_5_2_0,
        expected: RECORDED,
        expectedSource: ACCOUNT_ADDRESS_ENV,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Refusing to use, deploy or sign/);
    expect(message).toMatch(/constructor inputs/);
    expect(message).not.toContain(`changed it again to ${SCHNORR_CLASS_ID_6_0_0}`);
  });
});

describe("SchnorrAccount class", () => {
  // The refusal message names the class the runtime derives to. Pinned here so
  // the next SDK bump that moves it again fails a test instead of shipping a
  // message about the wrong class, and so the move is noticed at all.
  it("is the 6.0.0 class the identity error names", async () => {
    const cls = await getContractClassFromArtifact(SchnorrAccountContractArtifact);
    expect(cls.id.toString()).toBe(SCHNORR_CLASS_ID_6_0_0);
  });
});
