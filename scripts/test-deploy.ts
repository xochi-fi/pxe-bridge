import { AztecClient } from "../src/aztec-client.js";
import { FeeJuiceClaimSchema } from "../src/types.js";

const secretKey = process.env["PXE_BRIDGE_SECRET_KEY"];
if (!secretKey) {
  console.error("PXE_BRIDGE_SECRET_KEY is required");
  process.exit(1);
}

const raw = process.env["FEE_JUICE_CLAIM"];
const claim = raw ? FeeJuiceClaimSchema.parse(JSON.parse(raw)) : undefined;

const client = new AztecClient(
  process.env["AZTEC_NODE_URL"] ?? "http://localhost:8080",
  secretKey,
  claim,
);

try {
  await client.connect();
  console.log("SUCCESS: Account deployed/recovered");
  const version = await client.getVersion();
  console.log("Node version:", version);
} catch (e) {
  console.error("FAILED:", e);
  process.exit(1);
}
process.exit(0);
