/**
 * Shared helpers for the unit and integration suites.
 *
 * `Response.json()` resolves to `unknown` under this tsconfig (no DOM lib), so
 * every test that read a JSON-RPC response was implicitly relying on the suite
 * never being type-checked. These give the response a name instead of an `any`.
 */

/** A JSON-RPC 2.0 error object, per the spec's error member. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * A JSON-RPC 2.0 response. `result` and `error` are both optional because
 * exactly one is present and which one is what the tests assert on.
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id: number | string | null;
  result?: T;
  error?: JsonRpcError;
}

/**
 * Reads a JSON-RPC response body.
 *
 * The cast is the point: the server under test is the one producing this shape,
 * so validating it here would test the helper rather than the server. A
 * mismatch surfaces as a failing assertion in the caller, which is where it
 * belongs.
 */
export async function rpcJson<T = unknown>(res: Response): Promise<JsonRpcResponse<T>> {
  return (await res.json()) as JsonRpcResponse<T>;
}
