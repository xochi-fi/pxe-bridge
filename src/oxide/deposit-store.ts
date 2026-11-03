import type { OxideDepositJournal } from "./deposit-journal.js";
import type { VerifiedOxideDeposit } from "./deposit.js";

export interface OxideDepositPxe {
  messageReady(messageKey: string, inboxIndex: bigint): Promise<boolean>;
  storeDeposit(deposit: VerifiedOxideDeposit): Promise<void>;
  sendJournalMeta(): { journalId: string; generation: number };
}

export interface OxideDepositStoreHooks {
  afterVerified?: () => void | Promise<void>;
  afterSubmittingMarked?: () => void | Promise<void>;
  afterPxeSubmission?: () => void | Promise<void>;
}

export type OxideDepositStoreResult = "stored" | "already_stored";

/**
 * Stores one finalized deposit in PXE exactly once.
 *
 * The `submitting` marker is durable before the utility call. Oxide exposes no
 * PXE query keyed by the exact inbox-index fact, so a replay from that state
 * fails closed and never invokes `store_deposit` again. Aggregate private
 * balance is deliberately not evidence for one deposit's identity.
 */
export async function storeVerifiedOxideDeposit(
  journal: OxideDepositJournal,
  pxe: OxideDepositPxe,
  deposit: VerifiedOxideDeposit,
  hooks: OxideDepositStoreHooks = {},
): Promise<OxideDepositStoreResult> {
  const record = journal.recordVerified(deposit);
  if (record.state === "stored") return "already_stored";
  if (record.state === "submitting") {
    throw new Error(
      `PXE store outcome is ambiguous for ${deposit.txHash}; the durable submitting marker prevents a second store`,
    );
  }

  await hooks.afterVerified?.();
  if (!(await pxe.messageReady(deposit.messageKey, deposit.inboxIndex))) {
    throw new Error(
      `Oxide L1->L2 message ${deposit.messageKey} is not present at inbox index ${deposit.inboxIndex} in the PXE's latest block; retry after rollup settlement`,
    );
  }
  const sendJournal = pxe.sendJournalMeta();
  journal.markSubmitting(deposit.txHash, sendJournal);
  await hooks.afterSubmittingMarked?.();

  try {
    await pxe.storeDeposit(deposit);
  } catch (cause) {
    throw new Error(
      `PXE store outcome is ambiguous for ${deposit.txHash}; the durable submitting marker prevents a second store`,
      { cause },
    );
  }
  await hooks.afterPxeSubmission?.();

  const currentMeta = pxe.sendJournalMeta();
  if (
    currentMeta.journalId !== sendJournal.journalId ||
    currentMeta.generation !== sendJournal.generation
  ) {
    throw new Error(
      "Oxide send journal changed during PXE submission; the deposit remains ambiguous and will not be stored again",
    );
  }
  journal.markStored(deposit.txHash);
  return "stored";
}
