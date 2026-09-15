/**
 * The one guarded transition every resolution path goes through.
 *
 * A charge can be resolved by a callback (Daraja pushed us the answer) or by
 * the reconciler (we asked via stkQuery). Both must behave identically —
 * same guard, same terminal fields, same single ledger effect — or the two
 * paths could disagree and I3 would hold only by luck. So both call this.
 *
 * Must be invoked inside a transaction. The guard is
 * `WHERE status = 'PENDING'`: zero rows updated means someone else already
 * resolved this charge, and the caller must treat that as "not applied"
 * rather than retrying.
 */
import type { Tx } from '../db.js';
import type { ChargeRow } from '../types.js';
import { writeSalePaidOutbox } from './outbox.js';

export interface ChargeResolution {
  outcome: 'paid' | 'failed';
  resultCode: number;
  resultDesc: string;
  /** M-Pesa receipt, success only. */
  receipt?: string | null;
  /** When Daraja says the money moved. Defaults to now. */
  paidAt?: Date;
  resolvedBy: 'callback' | 'query';
}

export interface ApplyResult {
  applied: boolean;
  transition: 'PENDING->PAID' | 'PENDING->FAILED' | null;
  reason: string | null;
}

export async function applyChargeResolution(
  tx: Tx,
  charge: ChargeRow,
  resolution: ChargeResolution,
  now: Date,
): Promise<ApplyResult> {
  // A held charge is never resolved automatically, by either path. Something
  // about it did not add up (threat model A1) and a human owns it.
  if (charge.hold_reason) {
    return { applied: false, transition: null, reason: `charge on hold: ${charge.hold_reason}` };
  }

  const ts = now.toISOString();

  if (resolution.outcome === 'paid') {
    const paidAt = (resolution.paidAt ?? now).toISOString();
    const upd = await tx.query<{ id: string }>(
      `UPDATE charges
       SET status = 'PAID', mpesa_receipt = $2, result_code = $3, result_desc = $4, resolved_by = $5,
           paid_at = $6, updated_at = $7
       WHERE id = $1 AND status = 'PENDING'
       RETURNING id`,
      [
        charge.id,
        resolution.receipt ?? null,
        resolution.resultCode,
        resolution.resultDesc,
        resolution.resolvedBy,
        paidAt,
        ts,
      ],
    );
    if (upd.rowCount === 0) {
      return { applied: false, transition: null, reason: `charge already ${charge.status}` };
    }
    await writeSalePaidOutbox(tx, charge, resolution.paidAt ?? now, now);
    return { applied: true, transition: 'PENDING->PAID', reason: null };
  }

  const upd = await tx.query<{ id: string }>(
    `UPDATE charges
     SET status = 'FAILED', result_code = $2, result_desc = $3, resolved_by = $4, failed_at = $5, updated_at = $5
     WHERE id = $1 AND status = 'PENDING'
     RETURNING id`,
    [charge.id, resolution.resultCode, resolution.resultDesc, resolution.resolvedBy, ts],
  );
  if (upd.rowCount === 0) {
    return { applied: false, transition: null, reason: `charge already ${charge.status}` };
  }
  return { applied: true, transition: 'PENDING->FAILED', reason: null };
}
