import { ClaimService } from './claim-service';
import { EventStore } from './event-store';
import { ClaimEventType, DomainEvent } from '../domain/types';

const CAUSAL_TYPES: ReadonlySet<ClaimEventType> = new Set([
  'vehicle.valuation.recorded', 'total_loss.evaluated', 'salvage.disposal.started',
  'salvage.bid.received', 'salvage.bid.withdrawn', 'salvage.bid.expired', 'salvage.bid.selected',
  'salvage.disposal.failed', 'salvage.deal.completed', 'salvage.deal.reversed', 'salvage.income.posted',
  'vehicle.ownership.updated', 'adjustment.approved', 'payment.settled', 'payment.reversed',
]);

export class ReplayService {
  constructor(private readonly events: EventStore, private readonly claims: ClaimService) {}
  execute(claimId: string, until?: number) { const events = this.events.list(claimId).filter((event) => until === undefined || event.sequence <= until); return { claimId, eventCount: events.length, state: this.claims.replay(claimId, events), events }; }
  lineage(claimId: string) {
    const links = this.events.list(claimId).filter((event) => CAUSAL_TYPES.has(event.type)).map((event) => ({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, causality: causalityOf(event) }));
    return { claimId, links };
  }
}

function causalityOf(event: DomainEvent): Record<string, unknown> {
  const p = event.payload as any;
  switch (event.type) {
    case 'vehicle.valuation.recorded': return { valuationId: p.valuation.id, valuationVersion: p.valuation.version, supersedesValuationId: p.valuation.supersedes };
    case 'total_loss.evaluated': return { assessmentId: p.assessment.id, valuationId: p.assessment.valuationId, supersedesAssessmentId: p.assessment.supersedesAssessmentId, basisHash: p.assessment.basisHash, isTotalLoss: p.assessment.isTotalLoss };
    case 'salvage.disposal.started': return { taskId: p.disposal.taskId, assessmentId: p.disposal.assessmentId };
    case 'salvage.bid.received': return { bidId: p.bid.id, valuationVersion: p.bid.valuationVersion, amountMinor: p.bid.amountMinor };
    case 'salvage.bid.withdrawn': return { bidId: p.bidId };
    case 'salvage.bid.expired': return { bidId: p.bidId, reason: p.reason, supersededByValuationId: p.supersededByValuationId };
    case 'salvage.bid.selected': return { bidId: p.bidId, assessmentId: p.assessmentId };
    case 'salvage.disposal.failed': return { reason: p.reason };
    case 'salvage.deal.completed': return { dealId: p.deal.id, bidId: p.deal.bidId, callbackKey: p.deal.callbackKey, amountMinor: p.deal.amountMinor };
    case 'salvage.deal.reversed': return { dealId: p.dealId, bidId: p.bidId, reason: p.reason };
    case 'salvage.income.posted': return { dealId: p.dealId, paymentId: p.payment.id, sourceId: p.payment.sourceId, amountMinor: p.payment.amount.minor };
    case 'vehicle.ownership.updated': return { ownership: p.ownership, causedByEventId: p.causedBy };
    case 'adjustment.approved': return { approvedMinor: p.approvedMinor, causedByEventId: p.totalLoss?.causedBy, assessmentId: p.totalLoss?.assessmentId, salvageDeductionMinor: p.totalLoss?.salvageDeductionMinor, deductionBidId: p.totalLoss?.deductionBidId };
    case 'payment.settled': case 'payment.reversed': return { paymentId: p.payment.id, sourceId: p.payment.sourceId, amountMinor: p.payment.amount.minor };
    default: return {};
  }
}
