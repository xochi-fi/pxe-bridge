import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer32 } from "@aztec-labs/foundation/buffer";
import { EthAddress } from "@aztec-labs/stdlib/block";
import {
  assertL1Pinned,
  EnclaveTrustRefused,
  OxideFleetRegistry,
  verifyEnclaveAttestation,
  type OxideL1Reader,
} from "../src/oxide/enclave.js";
import { OXIDE_V6_MAINNET } from "../src/oxide/pins.js";
import type { AttestationData } from "../src/oxide/vendor/oxide-lib/attestation/attestation_data.js";
import { ethAddressFromSecpPublicKey } from "../src/oxide/vendor/oxide-lib/attestation/user_data.js";
import { DEFAULT_TIMEOUTS } from "../src/oxide/vendor/oxide-client/enclave_transport.js";
import { verifyAndPin, type FleetRegistry } from "../src/oxide/vendor/oxide-client/fleet_signer.js";
import { encodeOkResponse } from "../src/oxide/vendor/oxide-lib-tee/codec.js";
import { frame } from "../src/oxide/vendor/oxide-lib/framing.js";

/**
 * A real attestation document from the v6 fleet (enclave 0xcb88..., registry leaf 7, fetched
 * read-only with getAttestation on 2026-11-02). Public: COSE_Sign1 over PCRs
 * and the enclave's public keys.
 */
function fixture(): AttestationData {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/oxide/attestation-0xcb88.json", import.meta.url), "utf8")) as {
    attestation: string;
    userData: Record<"publicKeyX" | "publicKeyY" | "encPubKeyX" | "encPubKeyY", string>;
  };
  return {
    attestation: Buffer.from(raw.attestation, "base64"),
    userData: {
      publicKeyX: Buffer32.fromString(raw.userData.publicKeyX),
      publicKeyY: Buffer32.fromString(raw.userData.publicKeyY),
      encPubKeyX: Buffer32.fromString(raw.userData.encPubKeyX),
      encPubKeyY: Buffer32.fromString(raw.userData.encPubKeyY),
    },
  };
}

function reader(overrides: Partial<{ pcr0Hash: string; rootCaCertHash: string; frozen: boolean; chainId: bigint; txAmountCap: bigint; registered: boolean }> = {}): OxideL1Reader {
  const att = fixture();
  return {
    chainId: async () => overrides.chainId ?? 1n,
    pcr0Hash: async () => overrides.pcr0Hash ?? OXIDE_V6_MAINNET.pcr0Hash,
    rootCaCertHash: async () => overrides.rootCaCertHash ?? OXIDE_V6_MAINNET.rootCaCertHash,
    registration: async () => ({
      keys: {
        pubKeyX: att.userData.publicKeyX.toString(),
        pubKeyY: att.userData.publicKeyY.toString(),
        encPubKeyX: att.userData.encPubKeyX.toString(),
        encPubKeyY: att.userData.encPubKeyY.toString(),
      },
      messageKey: overrides.registered === false ? "0x" + "00".repeat(32) : "0x" + "01".padStart(64, "0"),
      leafIndex: 7n,
    }),
    portal: async () => ({
      l2Token: OXIDE_V6_MAINNET.bridge.l2Token,
      teeRegistry: "0x8b705C3519169F29850D156574ec377B686bd9CD",
      rollupVersion: OXIDE_V6_MAINNET.rollupVersion,
      txAmountCap: overrides.txAmountCap ?? OXIDE_V6_MAINNET.bridge.l2TokenImmutables.maxNoteAmount,
      frozen: overrides.frozen ?? false,
    }),
  };
}

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof EnclaveTrustRefused) return e.reason;
    throw e;
  }
  return undefined;
};

describe("enclave attestation", () => {
  it("accepts the live fleet's attestation: pinned PCR0, registry hash, Nitro chain to the AWS root", () => {
    expect(() => verifyEnclaveAttestation(fixture(), OXIDE_V6_MAINNET.pcr0Hash)).not.toThrow();
  });

  it("refuses when keccak(PCR0) is not TeeRegistry.PCR0_HASH()", () => {
    expect(reason(() => verifyEnclaveAttestation(fixture(), "0x" + "ee".repeat(32)))).toBe("pcr0_hash_mismatch");
  });

  it("refuses a PCR0 other than the pinned image, even if the registry agreed with it", () => {
    const pins = { ...OXIDE_V6_MAINNET, pcr0: "00".repeat(48) } as unknown as typeof OXIDE_V6_MAINNET;
    expect(reason(() => verifyEnclaveAttestation(fixture(), OXIDE_V6_MAINNET.pcr0Hash, pins))).toBe("pcr0_not_pinned");
  });

  it("refuses keys the document does not commit to", () => {
    const att = fixture();
    const swapped = { ...att, userData: { ...att.userData, encPubKeyX: Buffer32.fromString("0x" + "12".repeat(32)) } };
    expect(reason(() => verifyEnclaveAttestation(swapped, OXIDE_V6_MAINNET.pcr0Hash))).toBe("attestation_invalid");
  });

  it("refuses a tampered document", () => {
    const att = fixture();
    const bytes = Buffer.from(att.attestation);
    bytes[bytes.length - 10]! ^= 0xff; // inside the COSE signature
    expect(reason(() => verifyEnclaveAttestation({ ...att, attestation: bytes }, OXIDE_V6_MAINNET.pcr0Hash))).toBe(
      "attestation_invalid",
    );
  });

  it("OxideFleetRegistry reads PCR0_HASH live for every pin", async () => {
    const att = fixture();
    await expect(new OxideFleetRegistry(reader()).verifyAttestation(att)).resolves.toBeUndefined();
    await expect(new OxideFleetRegistry(reader({ pcr0Hash: "0x" + "ee".repeat(32) })).verifyAttestation(att)).rejects.toMatchObject({
      reason: "pcr0_hash_mismatch",
    });
  });

  it("OxideFleetRegistry answers the registered keys and refuses an unregistered enclave", async () => {
    const att = fixture();
    const tee = ethAddressFromSecpPublicKey({ x: att.userData.publicKeyX, y: att.userData.publicKeyY });
    expect(tee.toString()).toBe("0xcb88d07f5d30837d3de8a10fcdb7ba8abb3fbec6");
    const registration = await new OxideFleetRegistry(reader()).getRegistration(tee);
    expect(registration.leafIndex).toBe(7n);
    expect(registration.keys.encPubKeyY.equals(att.userData.encPubKeyY)).toBe(true);
    await expect(new OxideFleetRegistry(reader({ registered: false })).getRegistration(EthAddress.ZERO)).rejects.toThrow(
      /not registered/,
    );
  });
});

describe("assertL1Pinned", () => {
  it("accepts the pinned deployment", async () => {
    await expect(assertL1Pinned(reader())).resolves.toBeUndefined();
  });

  it.each([
    ["another chain", { chainId: 11155111n }],
    ["another PCR0 hash", { pcr0Hash: "0x" + "ee".repeat(32) }],
    ["another trust anchor", { rootCaCertHash: "0x" + "ee".repeat(32) }],
    ["another per-tx cap", { txAmountCap: 1n }],
  ])("refuses %s", async (_, overrides) => {
    await expect(assertL1Pinned(reader(overrides))).rejects.toMatchObject({ reason: "l1_not_pinned" });
  });

  it("refuses a frozen portal", async () => {
    await expect(assertL1Pinned(reader({ frozen: true }))).rejects.toMatchObject({ reason: "portal_frozen" });
  });
});

describe("verifyAndPin", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The fleet's plaintext getAttestation answer, framed as on the wire: the network boundary, faked. */
  function serveAttestation(att: AttestationData) {
    const fetch = vi.fn(async () => new Response(new Uint8Array(frame(encodeOkResponse(att))), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  /** A registry that records the order of its calls around a real one. */
  function recording(inner: FleetRegistry) {
    const calls: string[] = [];
    const registry: FleetRegistry = {
      portalDomain: inner.portalDomain,
      verifyAttestation: async (att) => {
        calls.push("verifyAttestation");
        await inner.verifyAttestation(att);
      },
      getRegistration: async (tee) => {
        calls.push("getRegistration");
        return inner.getRegistration(tee);
      },
    };
    return { registry, calls };
  }

  it("verifies the attestation before comparing or trusting any key in it, then pins", async () => {
    serveAttestation(fixture());
    const { registry, calls } = recording(new OxideFleetRegistry(reader()));
    const pinned = await verifyAndPin(OXIDE_V6_MAINNET.enclaveUrl, registry, DEFAULT_TIMEOUTS);
    expect(calls).toEqual(["verifyAttestation", "getRegistration"]);
    expect(pinned.ethAddress.toString()).toBe("0xcb88d07f5d30837d3de8a10fcdb7ba8abb3fbec6");
    expect(pinned.registrationLeafIndex).toBe(7n);
  });

  it("an attestation that fails verification is refused before the registry is read", async () => {
    serveAttestation(fixture());
    const { registry, calls } = recording(new OxideFleetRegistry(reader({ pcr0Hash: "0x" + "ee".repeat(32) })));
    await expect(verifyAndPin(OXIDE_V6_MAINNET.enclaveUrl, registry, DEFAULT_TIMEOUTS)).rejects.toMatchObject({
      reason: "pcr0_hash_mismatch",
    });
    expect(calls).toEqual(["verifyAttestation"]);
  });

  it("refuses an enclave whose attested keys are not the ones TeeRegistry holds", async () => {
    serveAttestation(fixture());
    const base = reader();
    const other: OxideL1Reader = {
      ...base,
      registration: async (tee) => {
        const registration = await base.registration(tee);
        return { ...registration, keys: { ...registration.keys, encPubKeyX: "0x" + "12".repeat(32) } };
      },
    };
    await expect(verifyAndPin(OXIDE_V6_MAINNET.enclaveUrl, new OxideFleetRegistry(other), DEFAULT_TIMEOUTS)).rejects.toThrow(
      /does not match the keys registered/,
    );
  });
});
