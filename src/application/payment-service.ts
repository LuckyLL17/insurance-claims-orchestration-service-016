import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}
  settle(claimId: string, input: { amount: number; currency: string; sourceId: string }, actor: string) {
    const claim = this.claims.get(claimId); if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    if (claim.status === 'settled') throw new Error('settled claim cannot receive an additional payment');
    const alreadyPaid = this.ledger.claimantSettlementBalance(claim.payments); const amountMinor = Math.round(input.amount * 100);
    if (alreadyPaid + amountMinor > claim.approvedMinor) throw new Error('payment exceeds approved amount');
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'settlement' });
    const updated = this.claims.addEvent(claimId, 'payment.settled', { payment }, actor, `payment:${input.sourceId}`);
    if (this.ledger.claimantSettlementBalance(updated.payments) === updated.approvedMinor) return this.claims.addEvent(claimId, 'claim.settled', { sourceId: input.sourceId, at: payment.createdAt }, actor, `settled:${input.sourceId}`);
    return updated;
  }
  reverse(claimId: string, input: { amount: number; currency: string; sourceId: string }, actor: string) {
    const claim = this.claims.get(claimId);
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'reversal' });
    return this.claims.addEvent(claimId, 'payment.reversed', { payment }, actor, `reversal:${input.sourceId}`);
  }
}
