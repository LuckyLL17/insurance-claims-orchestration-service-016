import { PaymentEntry } from './types';
import { asMinor, newId, iso } from './ids';

type LedgerInput = {
  kind: PaymentEntry['kind'];
  currency: string;
  sourceId: string;
  dispositionId?: string;
  quoteId?: string;
  basisVersion?: number;
  reversesPaymentId?: string;
};

export class PaymentLedger {
  post(entries: PaymentEntry[], input: LedgerInput & { amount: number }): PaymentEntry {
    return this.postMinor(entries, { ...input, amountMinor: asMinor(input.amount) });
  }

  postMinor(entries: PaymentEntry[], input: LedgerInput & { amountMinor: number }): PaymentEntry {
    if (entries.some((entry) => entry.sourceId === input.sourceId && entry.kind === input.kind)) throw new Error(`duplicate payment source ${input.sourceId}`);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('payment amount must be a positive integer minor amount');
    const negativeKinds = new Set<PaymentEntry['kind']>(['reversal', 'recovery']);
    return {
      id: newId('payment'),
      kind: input.kind,
      amount: { currency: input.currency, minor: negativeKinds.has(input.kind) ? -input.amountMinor : input.amountMinor },
      sourceId: input.sourceId,
      status: 'posted',
      createdAt: iso(),
      dispositionId: input.dispositionId,
      quoteId: input.quoteId,
      basisVersion: input.basisVersion,
      reversesPaymentId: input.reversesPaymentId
    };
  }

  balance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
  settlementBalance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.kind === 'settlement' && entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
  claimantSettlementBalance(entries: PaymentEntry[]): number {
    return entries
      .filter((entry) => entry.status === 'posted' && (entry.kind === 'settlement' || entry.kind === 'reversal'))
      .reduce((sum, entry) => sum + entry.amount.minor, 0);
  }
  recoveryBalance(entries: PaymentEntry[]): number {
    return entries
      .filter((entry) => entry.status === 'posted' && (entry.kind === 'recovery' || entry.kind === 'recovery_reversal'))
      .reduce((sum, entry) => sum + entry.amount.minor, 0);
  }
}
