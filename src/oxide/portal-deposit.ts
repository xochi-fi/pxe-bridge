/**
 * Minimal ABI copied from OxidePortal.sol, Caps.sol and IERC20 at
 * aztec-labs-eng/zkmoney-public commit
 * 8fd198412a956f214639b5782d3a86e3d47ca60e (2026-10-27). It intentionally
 * contains only the deposit path and the identity/cap reads that guard it.
 */
export const OXIDE_PORTAL_DEPOSIT_ABI = [
  {
    type: "function",
    name: "UNDERLYING",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "L2_TOKEN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "ROLLUP_VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "TX_AMOUNT_CAP",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getCurrentAvailable",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "$frozen",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipientCommitment", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "key", type: "bytes32" },
      { name: "index", type: "uint256" },
      { name: "creditedAmount", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Deposit",
    anonymous: false,
    inputs: [
      { name: "recipientCommitment", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "key", type: "bytes32", indexed: false },
      { name: "index", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Minimal IERC20 ABI for the canonical approve and pinned balance checks. */
export const OXIDE_UNDERLYING_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
