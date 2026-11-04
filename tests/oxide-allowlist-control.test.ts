import { describe, expect, it } from "vitest";
import type { RootUpdatePublisher } from "../src/attestation.js";
import type { SettlementJournal } from "../src/journal.js";
import { OxideAllowlistController } from "../src/oxide/allowlist-control.js";
import { OxideAllowlist } from "../src/oxide/allowlist.js";
import { OxideJournal } from "../src/oxide/journal.js";
import type { CorridorConfig } from "../src/settlement.js";
import { tempJournalPath } from "./oxide-fixtures.js";

const CORRIDOR: CorridorConfig = {
  corridorId: `0x${"71".repeat(32)}`,
  corridorRevision: 2,
  manifestDigest: `0x${"72".repeat(32)}`,
  genesisOrNetworkDigest: `0x${"73".repeat(32)}`,
};

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
  });
}

describe("OxideAllowlistController", () => {
  it("normalizes mixed-case recipients and terminally refuses a deterministic command", async () => {
    const seed = `0x${"0".repeat(62)}74`;
    const mixedCaseRecipient = `0x${"0".repeat(62)}aB`;
    const allowlist = await OxideAllowlist.build(seed, []);
    const journal = OxideJournal.open(tempJournalPath(), { allowCreate: true });
    journal.initializeAllowlistControl(allowlist.root, allowlist.snapshot());
    const requests: unknown[] = [];
    const replies = [
      response(200, {
        operation_id: "refuse-1",
        binding_id: "binding-1",
        action: "revoke",
        recipient: mixedCaseRecipient,
        state: "queued",
      }),
      response(204),
      response(200, {
        operation_id: "approve-2",
        binding_id: "binding-2",
        action: "approve",
        recipient: mixedCaseRecipient,
        state: "queued",
      }),
      response(204),
    ];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      const next = replies.shift();
      if (!next) throw new Error("unexpected control request");
      return next;
    }) as typeof fetch;
    const controller = new OxideAllowlistController(
      {
        url: "https://worker.example/control",
        token: "dedicated-control-token",
        admin: `0x${"75".repeat(20)}`,
        intervalMs: 10_000,
      },
      CORRIDOR,
      journal,
      null as unknown as SettlementJournal,
      allowlist,
      null as unknown as RootUpdatePublisher,
      fetchImpl,
    );

    await controller.tick();
    expect(requests[1]).toEqual({
      kind: "refusal",
      operation_id: "refuse-1",
      code: "recipient_not_allowed",
    });
    expect(journal.allowlistControlOperation("refuse-1")).toBeUndefined();

    await controller.tick();
    expect(requests[3]).toMatchObject({ kind: "proposal", operation_id: "approve-2" });
    expect(journal.allowlistControlOperation("approve-2")).toMatchObject({
      recipient: mixedCaseRecipient.toLowerCase(),
      state: "prepared",
    });
    expect(replies).toEqual([]);
  });
});
