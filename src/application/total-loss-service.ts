import { ClaimService } from './claim-service';
import { EventStore } from './event-store';
import { PaymentLedger } from '../domain/payment-ledger';
import { bestStandingBid, clampApproved, DEFAULT_TOTAL_LOSS_THRESHOLD_RATIO, latestValuation } from '../domain/total-loss';
import { ClaimState, SalvageBid, SalvageDeal, TotalLossAssessment, VehicleValuation } from '../domain/types';
import { asMinor, iso, newId, stableHash } from '../domain/ids';

export class TotalLossService {
  constructor(private readonly claims: ClaimService, private readonly events: EventStore, private readonly ledger: PaymentLedger) {}

  private state(claimId: string): ClaimState { return this.claims.get(claimId); }

  recordValuation(claimId: string, input: { marketValue: number; currency?: string; assessor: string; assessedAt?: string }, actor: string, key?: string): ClaimState {
    const claim = this.state(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be re-valued');
    const latest = latestValuation(claim);
    const valuation: VehicleValuation = { id: newId('valuation'), version: (latest?.version ?? 0) + 1, marketValueMinor: asMinor(input.marketValue), currency: input.currency ?? 'CNY', assessor: input.assessor, assessedAt: iso(input.assessedAt), supersedes: latest?.id };
    if (valuation.marketValueMinor <= 0) throw new Error('market value must be positive');
    this.events.append(claimId, 'vehicle.valuation.recorded', { valuation }, actor, key);
    for (const bid of this.state(claimId).bids.filter((b) => b.status === 'open' && b.valuationVersion < valuation.version)) {
      this.events.append(claimId, 'salvage.bid.expired', { bidId: bid.id, reason: 'valuation_superseded', supersededByValuationId: valuation.id }, 'system', `expire:${bid.id}:valuation:${valuation.id}`);
    }
    return this.state(claimId);
  }

  evaluate(claimId: string, input: { repairEstimate?: number; thresholdRatio?: number }, actor: string, key?: string): ClaimState {
    const claim = this.state(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be evaluated');
    if (claim.deal?.status === 'completed') throw new Error('salvage deal already completed; reverse it before re-evaluating');
    const valuation = latestValuation(claim);
    if (!valuation) throw new Error('vehicle valuation required before total loss evaluation');
    const ratio = input.thresholdRatio ?? DEFAULT_TOTAL_LOSS_THRESHOLD_RATIO;
    if (!(ratio > 0 && ratio <= 2)) throw new Error('threshold ratio must be within (0, 2]');
    const repairEstimateMinor = asMinor(input.repairEstimate ?? claim.loss.gross);
    const thresholdMinor = Math.round(valuation.marketValueMinor * ratio);
    const basis = { valuationId: valuation.id, valuationVersion: valuation.version, repairEstimateMinor, thresholdRatio: ratio, thresholdMinor, marketValueMinor: valuation.marketValueMinor, ruleVersion: claim.ruleSnapshot?.version };
    const assessment: TotalLossAssessment = { id: newId('assessment'), ...basis, isTotalLoss: repairEstimateMinor >= thresholdMinor, decidedAt: iso(), basisHash: stableHash(basis), supersedesAssessmentId: claim.currentAssessmentId };
    this.events.append(claimId, 'total_loss.evaluated', { assessment }, actor, key);
    const after = this.state(claimId);
    if (assessment.isTotalLoss) {
      if (!after.disposal || after.disposal.status === 'failed') {
        const disposal = { taskId: newId('salvage-task'), assessmentId: assessment.id, status: 'collecting' as const, createdAt: iso() };
        this.events.append(claimId, 'salvage.disposal.started', { disposal }, 'system', `disposal:${claimId}:${assessment.id}`);
      }
    } else if (after.disposal && (after.disposal.status === 'collecting' || after.disposal.status === 'selected')) {
      this.failDisposal(claimId, { reason: 'no_longer_total_loss' }, 'system', `fail:${claimId}:${assessment.id}`);
    }
    return this.state(claimId);
  }

  receiveBid(claimId: string, input: { bidder: string; amount: number; currency?: string; validUntil: string }, actor: string, key?: string): ClaimState {
    const claim = this.state(claimId);
    if (!claim.disposal || claim.disposal.status !== 'collecting') throw new Error('no salvage disposal is collecting bids');
    const valuation = latestValuation(claim);
    if (!valuation) throw new Error('vehicle valuation required before receiving bids');
    if (!input.bidder) throw new Error('bidder is required');
    const bid: SalvageBid = { id: newId('bid'), bidder: input.bidder, amountMinor: asMinor(input.amount), currency: input.currency ?? valuation.currency, valuationVersion: valuation.version, receivedAt: iso(), validUntil: iso(input.validUntil), status: 'open' };
    if (bid.amountMinor <= 0) throw new Error('bid amount must be positive');
    if (new Date(bid.validUntil) <= new Date()) throw new Error('bid validity must be in the future');
    this.events.append(claimId, 'salvage.bid.received', { bid }, actor, key);
    return this.state(claimId);
  }

  withdrawBid(claimId: string, bidId: string, actor: string, key?: string): ClaimState {
    const claim = this.state(claimId);
    const bid = claim.bids.find((b) => b.id === bidId);
    if (!bid) throw new Error(`unknown bid ${bidId}`);
    if (bid.status !== 'open') throw new Error(`bid is ${bid.status} and cannot be withdrawn`);
    this.events.append(claimId, 'salvage.bid.withdrawn', { bidId }, actor, key);
    return this.state(claimId);
  }

  expireBids(claimId: string, at?: string, actor = 'system'): ClaimState {
    const claim = this.state(claimId);
    const now = new Date(iso(at));
    for (const bid of claim.bids.filter((b) => b.status === 'open' && new Date(b.validUntil) <= now)) {
      this.events.append(claimId, 'salvage.bid.expired', { bidId: bid.id, reason: 'ttl' }, actor, `expire:${bid.id}:ttl`);
    }
    return this.state(claimId);
  }

  selectBid(claimId: string, bidId: string, actor: string, key?: string): ClaimState {
    const claim = this.state(claimId);
    if (!claim.disposal || (claim.disposal.status !== 'collecting' && claim.disposal.status !== 'selected')) throw new Error('no salvage disposal accepting selection');
    const bid = claim.bids.find((b) => b.id === bidId);
    if (!bid) throw new Error(`unknown bid ${bidId}`);
    if (bid.status !== 'open') throw new Error(`bid is ${bid.status} and cannot be selected`);
    if (new Date(bid.validUntil) <= new Date()) {
      this.events.append(claimId, 'salvage.bid.expired', { bidId: bid.id, reason: 'ttl' }, 'system', `expire:${bid.id}:ttl`);
      throw new Error('bid has expired');
    }
    const valuation = latestValuation(claim);
    if (valuation && bid.valuationVersion !== valuation.version) throw new Error('bid is based on a superseded valuation and cannot change the current payout conclusion');
    this.events.append(claimId, 'salvage.bid.selected', { bidId: bid.id, amountMinor: bid.amountMinor, assessmentId: claim.currentAssessmentId }, actor, key);
    return this.state(claimId);
  }

  failDisposal(claimId: string, input: { reason?: string }, actor: string, key?: string): ClaimState {
    const claim = this.state(claimId);
    if (!claim.disposal || claim.disposal.status === 'failed' || claim.disposal.status === 'completed') throw new Error('no active salvage disposal to fail');
    if (claim.deal?.status === 'completed') throw new Error('completed deal must be reversed before failing disposal');
    const valuation = latestValuation(claim);
    if (!valuation) throw new Error('vehicle valuation required before failing disposal');
    const reason = input.reason ?? 'no acceptable bids';
    const failure = this.events.append(claimId, 'salvage.disposal.failed', { reason, failedAt: iso() }, actor, key);
    this.events.append(claimId, 'vehicle.ownership.updated', { ownership: 'retained_by_owner', decidedAt: iso(), causedBy: failure.id }, 'system', `ownership:${claimId}:retained:${failure.id}`);
    const noLongerTotalLoss = reason === 'no_longer_total_loss';
    const best = bestStandingBid(claim.bids);
    const assessment = this.state(claimId).assessments.find((a) => a.id === this.state(claimId).currentAssessmentId);
    const baseMinor = noLongerTotalLoss ? assessment?.repairEstimateMinor ?? valuation.marketValueMinor : valuation.marketValueMinor;
    this.approveTotalLoss(claimId, failure.id, { baseMinor, deductionMinor: noLongerTotalLoss ? 0 : best?.amountMinor ?? 0, deductionBidId: noLongerTotalLoss ? undefined : best?.id, incomeMinor: 0, ownership: 'retained_by_owner' });
    return this.state(claimId);
  }

  completeDeal(claimId: string, input: { bidId: string; amount?: number; currency?: string; callbackKey: string; completedAt?: string }, actor: string, key?: string): ClaimState {
    const claim = this.state(claimId);
    if (!input.callbackKey) throw new Error('callbackKey is required for deal callbacks');
    const existing = claim.deal;
    if (existing && existing.bidId === input.bidId && existing.callbackKey === input.callbackKey) return claim;
    if (existing?.status === 'completed') throw new Error('a different salvage deal is already completed');
    if (!claim.disposal || claim.disposal.status !== 'selected' || claim.selectedBidId !== input.bidId) throw new Error('bid is not currently selected for disposal');
    const bid = claim.bids.find((b) => b.id === input.bidId);
    if (!bid || bid.status !== 'selected') throw new Error('selected bid not found');
    const completedAt = iso(input.completedAt);
    if (new Date(bid.validUntil) <= new Date(completedAt)) {
      this.events.append(claimId, 'salvage.bid.expired', { bidId: bid.id, reason: 'ttl' }, 'system', `expire:${bid.id}:ttl`);
      throw new Error('bid expired before deal completion');
    }
    const amountMinor = input.amount === undefined ? bid.amountMinor : asMinor(input.amount);
    if (amountMinor <= 0) throw new Error('deal amount must be positive');
    const deal: SalvageDeal = { id: newId('deal'), bidId: bid.id, amountMinor, currency: input.currency ?? bid.currency, completedAt, callbackKey: input.callbackKey, status: 'completed' };
    const dealEvent = this.events.append(claimId, 'salvage.deal.completed', { deal }, actor, key ?? `deal:${claimId}:${input.callbackKey}`);
    const payment = this.ledger.post(this.state(claimId).payments, { kind: 'recovery', amount: amountMinor / 100, currency: deal.currency, sourceId: `salvage:${deal.id}` });
    this.events.append(claimId, 'salvage.income.posted', { payment, dealId: deal.id }, 'system', `income:${deal.id}`);
    this.events.append(claimId, 'vehicle.ownership.updated', { ownership: 'transferred_to_insurer', decidedAt: iso(), causedBy: dealEvent.id }, 'system', `ownership:${claimId}:transferred:${deal.id}`);
    const valuation = latestValuation(this.state(claimId));
    this.approveTotalLoss(claimId, dealEvent.id, { baseMinor: valuation?.marketValueMinor ?? 0, deductionMinor: 0, incomeMinor: amountMinor, ownership: 'transferred_to_insurer' });
    return this.state(claimId);
  }

  reverseDeal(claimId: string, input: { reason: string }, actor: string, key?: string): ClaimState {
    const claim = this.state(claimId);
    const deal = claim.deal;
    if (!deal || deal.status !== 'completed') throw new Error('no completed salvage deal to reverse');
    const reversal = this.events.append(claimId, 'salvage.deal.reversed', { dealId: deal.id, bidId: deal.bidId, reason: input.reason, reversedAt: iso() }, actor, key);
    this.events.append(claimId, 'vehicle.ownership.updated', { ownership: 'pending', decidedAt: iso(), causedBy: reversal.id }, 'system', `ownership:${claimId}:pending:${deal.id}`);
    return this.state(claimId);
  }

  summary(claimId: string) { const claim = this.state(claimId); return { valuations: claim.valuations, currentAssessment: claim.assessments.find((a) => a.id === claim.currentAssessmentId) ?? null, history: claim.assessments }; }
  salvage(claimId: string) { const claim = this.state(claimId); return { disposal: claim.disposal ?? null, bids: claim.bids, selectedBidId: claim.selectedBidId ?? null, deal: claim.deal ?? null, ownership: claim.ownership, salvageIncomeMinor: claim.salvageIncomeMinor, salvagePayments: claim.payments.filter((p) => p.sourceId.startsWith('salvage:')) }; }

  private approveTotalLoss(claimId: string, causedByEventId: string, opts: { baseMinor: number; deductionMinor: number; deductionBidId?: string; incomeMinor: number; ownership: string }): void {
    const claim = this.state(claimId);
    const approvedMinor = clampApproved(opts.baseMinor - (claim.policy?.deductibleMinor ?? 0) - opts.deductionMinor, claim.policy?.limitMinor);
    this.events.append(claimId, 'adjustment.approved', { approvedMinor, requiredEvidence: [...claim.requiredEvidence], totalLoss: { causedBy: causedByEventId, assessmentId: claim.currentAssessmentId, salvageDeductionMinor: opts.deductionMinor, deductionBidId: opts.deductionBidId, salvageIncomeMinor: opts.incomeMinor, ownership: opts.ownership } }, 'system', `adjustment:${claimId}:${causedByEventId}`);
  }
}
