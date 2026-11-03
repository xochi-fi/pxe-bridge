import { X509Certificate } from "node:crypto";
import { Buffer32 } from "@aztec-labs/foundation/buffer";
import { keccak256 } from "@aztec-labs/foundation/crypto/keccak";
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address";
import { EthAddress } from "@aztec-labs/stdlib/block";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import type { AttestationData } from "./vendor/oxide-lib/attestation/attestation_data.js";
import { getPcr0, hashPcr0 } from "./vendor/oxide-lib/attestation/pcr0.js";
import { verifyTeeAttestation } from "./vendor/oxide-lib/attestation/verify_tee_attestation.js";
import type { PortalDomain } from "./vendor/oxide-lib/types.js";
import type { FleetRegistry, TEEKeys } from "./vendor/oxide-client/fleet_signer.js";
import { OXIDE_V6_MAINNET, type OxidePins } from "./pins.js";

/**
 * The enclave trust checks the Oxide sender runs before it seals anything to an
 * enclave (xochi-fi/pxe-bridge#84), and the L1 reads they rest on.
 *
 * Upstream `verifyAndPin` trusts an enclave because `TeeRegistry` registered its
 * keys, and the registry admits only its own PCR0. That holds only while the
 * registry contract is the one we think it is, so the sender also checks the
 * attestation itself: its PCR0 must be the pinned image AND hash to the
 * registry's live `PCR0_HASH()`, and its COSE signature must chain to the AWS
 * Nitro root and commit to the keys it carries. Validation time is the
 * attestation's own timestamp: the fleet's documents are from registration
 * (2026-10-26) and their leaf certificates have expired, which upstream accepts
 * for the same reason (the registration is the freshness anchor).
 */

/**
 * AWS Nitro Enclaves root G1 (https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip),
 * SHA-256 fingerprint 64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B.
 * keccak256 of its DER is the pinned `CertManager.ROOT_CA_CERT_HASH()`.
 */
export const AWS_NITRO_ROOT_G1_PEM = `-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----`;

export function awsNitroRootDer(): Buffer {
  return Buffer.from(new X509Certificate(AWS_NITRO_ROOT_G1_PEM).raw);
}

export type EnclaveRefusal =
  | "pcr0_not_pinned"
  | "pcr0_hash_mismatch"
  | "attestation_invalid"
  | "l1_not_pinned"
  | "portal_frozen";

/** The enclave image, its attestation or its L1 registration is not the pinned one. Never retried in place. */
export class EnclaveTrustRefused extends Error {
  constructor(
    readonly reason: EnclaveRefusal,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Oxide enclave refused (${reason}): ${detail}`, options);
    this.name = "EnclaveTrustRefused";
  }
}

/**
 * Whether a refusal is STRUCTURAL: the live deployment is not the pinned one
 * (another enclave image, a registry whose `PCR0_HASH()` is not keccak of the
 * pinned PCR0, a chain/registry/portal other than the pins), which no retry of
 * this process clears -- only a reviewed re-pin and a new release do. A send
 * refused for one of these is `not_submitted` and NOT retryable (xochi#748
 * OX-6). `attestation_invalid` is one document from one fleet member and the
 * next connection may reach another; `portal_frozen` is Oxide's own pause,
 * lifted by its admin. Both stay transient.
 */
export function enclaveRefusalPermanent(reason: EnclaveRefusal): boolean {
  return reason === "pcr0_not_pinned" || reason === "pcr0_hash_mismatch" || reason === "l1_not_pinned";
}

/** What the sender reads from L1. Every method is a view call. */
export interface OxideL1Reader {
  chainId(): Promise<bigint>;
  /** `TeeRegistry.PCR0_HASH()`, 0x-hex. */
  pcr0Hash(): Promise<string>;
  /** `CertManager.ROOT_CA_CERT_HASH()` of the registry's `TEE_CERT_MANAGER()`, 0x-hex. */
  rootCaCertHash(): Promise<string>;
  /** `TeeRegistry.$teeKeys(tee)` and `$registrationMessages(tee)`; zero keys for an unregistered enclave. */
  registration(tee: string): Promise<{
    keys: { pubKeyX: string; pubKeyY: string; encPubKeyX: string; encPubKeyY: string };
    messageKey: string;
    leafIndex: bigint;
  }>;
  portal(): Promise<{
    l2Token: string;
    teeRegistry: string;
    rollupVersion: bigint;
    txAmountCap: bigint;
    frozen: boolean;
  }>;
}

const TEE_REGISTRY_ABI = parseAbi([
  "function PCR0_HASH() view returns (bytes32)",
  "function TEE_CERT_MANAGER() view returns (address)",
  "function $teeKeys(address tee) view returns (bytes32 pubKeyX, bytes32 pubKeyY, bytes32 encPubKeyX, bytes32 encPubKeyY)",
  "function $registrationMessages(address tee) view returns (bytes32 key, uint256 index)",
]);
const CERT_MANAGER_ABI = parseAbi(["function ROOT_CA_CERT_HASH() view returns (bytes32)"]);
const PORTAL_ABI = parseAbi([
  "function L2_TOKEN() view returns (bytes32)",
  "function TEE_REGISTRY() view returns (address)",
  "function ROLLUP_VERSION() view returns (uint256)",
  "function TX_AMOUNT_CAP() view returns (uint128)",
  "function $frozen() view returns (bool)",
]);

/** `OxideL1Reader` over an L1 JSON-RPC endpoint. Read-only: no wallet client exists. */
export function viemL1Reader(rpcUrl: string, pins: OxidePins = OXIDE_V6_MAINNET): OxideL1Reader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }) });
  const registry = pins.teeRegistry as Hex;
  const portal = pins.bridge.portal as Hex;
  return {
    chainId: async () => BigInt(await client.getChainId()),
    pcr0Hash: () => client.readContract({ address: registry, abi: TEE_REGISTRY_ABI, functionName: "PCR0_HASH" }),
    rootCaCertHash: async () => {
      const certManager = await client.readContract({
        address: registry,
        abi: TEE_REGISTRY_ABI,
        functionName: "TEE_CERT_MANAGER",
      });
      return client.readContract({ address: certManager, abi: CERT_MANAGER_ABI, functionName: "ROOT_CA_CERT_HASH" });
    },
    registration: async (tee) => {
      const [keys, message] = await Promise.all([
        client.readContract({ address: registry, abi: TEE_REGISTRY_ABI, functionName: "$teeKeys", args: [tee as Hex] }),
        client.readContract({
          address: registry,
          abi: TEE_REGISTRY_ABI,
          functionName: "$registrationMessages",
          args: [tee as Hex],
        }),
      ]);
      const [pubKeyX, pubKeyY, encPubKeyX, encPubKeyY] = keys;
      return { keys: { pubKeyX, pubKeyY, encPubKeyX, encPubKeyY }, messageKey: message[0], leafIndex: message[1] };
    },
    portal: async () => {
      const read = <F extends "L2_TOKEN" | "TEE_REGISTRY" | "ROLLUP_VERSION" | "TX_AMOUNT_CAP" | "$frozen">(
        functionName: F,
      ) => client.readContract({ address: portal, abi: PORTAL_ABI, functionName });
      const [l2Token, teeRegistry, rollupVersion, txAmountCap, frozen] = await Promise.all([
        read("L2_TOKEN"),
        read("TEE_REGISTRY"),
        read("ROLLUP_VERSION"),
        read("TX_AMOUNT_CAP"),
        read("$frozen"),
      ]);
      return { l2Token, teeRegistry, rollupVersion, txAmountCap, frozen };
    },
  };
}

const eqHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Refuses unless L1 still holds the pinned deployment: the chain, the
 * registry's PCR0 hash, the registry's trust anchor (which must be the AWS root
 * this module verifies against), and the portal's token, registry, rollup
 * version and per-tx cap. A frozen portal is refused too: its notes can only be
 * refunded on L1, so a payout there pays nobody.
 */
export async function assertL1Pinned(reader: OxideL1Reader, pins: OxidePins = OXIDE_V6_MAINNET): Promise<void> {
  const [chainId, pcr0Hash, rootHash, portal] = await Promise.all([
    reader.chainId(),
    reader.pcr0Hash(),
    reader.rootCaCertHash(),
    reader.portal(),
  ]);
  const off: string[] = [];
  if (chainId !== pins.l1ChainId) off.push(`chainId ${chainId}`);
  if (!eqHex(pcr0Hash, pins.pcr0Hash)) off.push("TeeRegistry.PCR0_HASH");
  if (!eqHex(pcr0Hash, hashPcr0(Buffer.from(pins.pcr0, "hex")).toString())) off.push("pinned pcr0 vs pcr0Hash");
  if (!eqHex(rootHash, pins.rootCaCertHash)) off.push("CertManager.ROOT_CA_CERT_HASH");
  if (!eqHex(rootHash, `0x${keccak256(awsNitroRootDer()).toString("hex")}`)) off.push("AWS root vs ROOT_CA_CERT_HASH");
  if (!eqHex(portal.l2Token, pins.bridge.l2Token)) off.push("OxidePortal.L2_TOKEN");
  if (!eqHex(portal.teeRegistry, pins.teeRegistry)) off.push("OxidePortal.TEE_REGISTRY");
  if (portal.rollupVersion !== pins.rollupVersion) off.push("OxidePortal.ROLLUP_VERSION");
  if (portal.txAmountCap !== pins.bridge.l2TokenImmutables.maxNoteAmount) off.push("OxidePortal.TX_AMOUNT_CAP");
  if (off.length > 0) throw new EnclaveTrustRefused("l1_not_pinned", off.join(", "));
  if (portal.frozen) throw new EnclaveTrustRefused("portal_frozen", `portal ${pins.bridge.portal} is frozen`);
}

/**
 * The checks on one attestation document, before any key in it is trusted.
 * `onChainPcr0Hash` is `TeeRegistry.PCR0_HASH()` read for this pin.
 */
export function verifyEnclaveAttestation(
  attestation: AttestationData,
  onChainPcr0Hash: string,
  pins: OxidePins = OXIDE_V6_MAINNET,
): void {
  let pcr0: Buffer;
  try {
    pcr0 = getPcr0(attestation.attestation);
  } catch (cause) {
    throw new EnclaveTrustRefused("attestation_invalid", "PCR0 unreadable", { cause });
  }
  if (pcr0.toString("hex") !== pins.pcr0) {
    throw new EnclaveTrustRefused("pcr0_not_pinned", `PCR0 ${pcr0.toString("hex")} is not the pinned image`);
  }
  const hash = hashPcr0(pcr0).toString();
  if (!eqHex(hash, onChainPcr0Hash)) {
    throw new EnclaveTrustRefused(
      "pcr0_hash_mismatch",
      `keccak(PCR0) ${hash} is not TeeRegistry.PCR0_HASH() ${onChainPcr0Hash}`,
    );
  }
  try {
    verifyTeeAttestation({
      attestationDocument: attestation.attestation,
      trustedRootCertificates: [awsNitroRootDer()],
      userData: attestation.userData,
    });
  } catch (cause) {
    throw new EnclaveTrustRefused("attestation_invalid", (cause as Error).message ?? String(cause), { cause });
  }
}

/** The pinned portal domain the enclave signs over. Never read from the portal at pin time. */
export function pinnedPortalDomain(pins: OxidePins = OXIDE_V6_MAINNET): PortalDomain {
  return {
    l1Portal: EthAddress.fromString(pins.bridge.portal),
    l2Token: AztecAddress.fromStringUnsafe(pins.bridge.l2Token),
    teeRegistry: EthAddress.fromString(pins.teeRegistry),
    l1ChainId: pins.l1ChainId,
    rollupVersion: pins.rollupVersion,
  };
}

/** `FleetRegistry` for the vendored `FleetSigner`: pinned domain, live registry reads, attestation checks. */
export class OxideFleetRegistry implements FleetRegistry {
  readonly portalDomain: PortalDomain;

  constructor(
    private readonly reader: OxideL1Reader,
    private readonly pins: OxidePins = OXIDE_V6_MAINNET,
  ) {
    this.portalDomain = pinnedPortalDomain(pins);
  }

  async verifyAttestation(attestation: AttestationData): Promise<void> {
    verifyEnclaveAttestation(attestation, await this.reader.pcr0Hash(), this.pins);
  }

  async getRegistration(tee: EthAddress): Promise<{ leafIndex: bigint; keys: TEEKeys }> {
    const { keys, messageKey, leafIndex } = await this.reader.registration(tee.toString());
    if (BigInt(messageKey) === 0n) {
      throw new Error(`TEE ${tee.toString()} is not registered on TeeRegistry ${this.pins.teeRegistry}`);
    }
    return {
      leafIndex,
      keys: {
        pubKeyX: Buffer32.fromString(keys.pubKeyX),
        pubKeyY: Buffer32.fromString(keys.pubKeyY),
        encPubKeyX: Buffer32.fromString(keys.encPubKeyX),
        encPubKeyY: Buffer32.fromString(keys.encPubKeyY),
      },
    };
  }
}
