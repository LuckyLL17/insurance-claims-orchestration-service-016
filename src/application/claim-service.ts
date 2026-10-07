import { EventStore } from './event-store';
import { EvidenceLedger } from '../domain/evidence';
import { PolicyCatalog } from '../domain/policy';
import { RuleEngine } from '../domain/rules';
import { ClaimReportedPayload, ClaimState, DomainEvent, EvidenceRecord } from '../domain/types';
import { newId, iso } from '../domain/ids';

export class ClaimService {
  constructor(private readonly events: EventStore, private readonly policies: PolicyCatalog, private readonly rules: RuleEngine, private readonly evidence: EvidenceLedger) {}

  create(input: ClaimReportedPayload, actor: string, key?: string): ClaimState {
    const id = newId('claim');
    this.events.append(id, 'claim.reported', { ...input, lossAt: iso(input.lossAt), reportedAt: iso(input.reportedAt) }, actor, key);
    this.events.append(id, 'policy.snapshot.created', { policy: this.policies.snapshot(input.policyId, input.lossAt), ruleSnapshot: this.rules.freeze() }, 'system', `policy:${id}`);
    return this.get(id);
  }

  addEvent(id: string, type: DomainEvent['type'], payload: unknown, actor: string, key?: string, occurredAt?: string): ClaimState { this.assertExists(id); this.events.append(id, type, payload, actor, key, occurredAt); return this.get(id); }

  addEvidence(id: string, input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.add(input, claim.evidence); return this.addEvent(id, 'evidence.added', { evidence: record }, actor, key, input.receivedAt);
  }

  reviewEvidence(id: string, evidenceId: string, accepted: boolean, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.review(evidenceId, accepted, claim.evidence); return this.addEvent(id, 'evidence.reviewed', { evidence: record }, actor, key);
  }

  get(id: string): ClaimState { return this.replay(id, this.events.list(id)); }
  replay(id: string, events: DomainEvent[]): ClaimState {
    const state = this.empty(id);
    for (const event of events.sort((a, b) => a.sequence - b.sequence)) this.apply(state, event);
    if (!state.policy) throw new Error(`claim ${id} has no policy snapshot`);
    return state;
  }

  private empty(id: string): ClaimState { return { id, policyId: '', status: 'reported', lossAt: '', reportedAt: '', channel: '', participants: [], loss: { currency: 'CNY', gross: 0 }, evidence: [], requiredEvidence: new Set(), completedSurveys: [], pendingDocuments: [], riskSignals: [], riskScore: 0, payments: [], approvedMinor: 0, valuations: [], assessments: [], bids: [], ownership: { status: 'pending' }, salvageIncomeMinor: 0, audit: [], processedEventIds: new Set(), version: 0 }; }
  private assertExists(id: string): void { if (this.events.list(id).length === 0) throw new Error(`unknown claim ${id}`); }

  private apply(state: ClaimState, event: DomainEvent): void {
    if (state.processedEventIds.has(event.id)) return; state.processedEventIds.add(event.id); state.version = event.sequence;
    const payload = event.payload as any;
    if (event.type === 'claim.reported') { state.policyId = payload.policyId; state.lossAt = payload.lossAt; state.reportedAt = payload.reportedAt; state.channel = payload.channel; state.participants = payload.participants; state.loss = payload.loss; state.status = 'reported'; }
    if (event.type === 'policy.snapshot.created') { state.policy = payload.policy; state.ruleSnapshot = payload.ruleSnapshot; }
    if (event.type === 'evidence.added') { state.evidence = [...state.evidence.filter((e) => e.id !== payload.evidence.id), payload.evidence]; state.status = state.status === 'reported' ? 'investigating' : state.status; }
    if (event.type === 'evidence.reviewed') { state.evidence = state.evidence.map((e) => e.id === payload.evidence.id ? payload.evidence : e); }
    if (event.type === 'documents.requested') { state.pendingDocuments = [...new Set([...(state.pendingDocuments), ...(payload.kinds ?? [])])]; state.status = 'awaiting_documents'; }
    if (event.type === 'documents.received') { state.pendingDocuments = state.pendingDocuments.filter((kind) => !(payload.kinds ?? []).includes(kind)); if (!state.pendingDocuments.length) state.status = 'ready_for_adjustment'; }
    if (event.type === 'survey.completed') { state.completedSurveys = [...new Set([...state.completedSurveys, payload.taskId])]; }
    if (event.type === 'risk.assessed') { state.riskSignals = payload.signals; state.riskScore = payload.score; }
    if (event.type === 'adjustment.approved') { state.approvedMinor = payload.approvedMinor; state.requiredEvidence = new Set(payload.requiredEvidence); state.status = 'ready_for_adjustment'; }
    if (event.type === 'payment.settled' || event.type === 'payment.reversed') { state.payments = [...state.payments, payload.payment]; state.status = payload.payment.kind === 'reversal' ? 'reopened' : 'partially_paid'; }
    if (event.type === 'claim.reopened') state.status = 'reopened';
    if (event.type === 'claim.rejected') state.status = 'rejected';
    if (event.type === 'vehicle.valuation.recorded') state.valuations = [...state.valuations.filter((v) => v.id !== payload.valuation.id), payload.valuation];
    if (event.type === 'total_loss.evaluated') { state.assessments = [...state.assessments.filter((a) => a.id !== payload.assessment.id), payload.assessment]; state.currentAssessmentId = payload.assessment.id; if (payload.assessment.isTotalLoss) state.status = 'total_loss_candidate'; else if (state.status === 'total_loss_candidate' || state.status === 'salvage_disposal') state.status = 'ready_for_adjustment'; }
    if (event.type === 'salvage.disposal.started') { state.disposal = payload.disposal; state.bids = []; state.selectedBidId = undefined; state.deal = undefined; state.status = 'salvage_disposal'; }
    if (event.type === 'salvage.bid.received') state.bids = [...state.bids.filter((b) => b.id !== payload.bid.id), payload.bid];
    if (event.type === 'salvage.bid.withdrawn') state.bids = state.bids.map((b) => b.id === payload.bidId ? { ...b, status: 'withdrawn' as const } : b);
    if (event.type === 'salvage.bid.expired') state.bids = state.bids.map((b) => b.id === payload.bidId && b.status === 'open' ? { ...b, status: 'expired' as const, expiredReason: payload.reason } : b);
    if (event.type === 'salvage.bid.selected') { state.bids = state.bids.map((b) => b.id === payload.bidId ? { ...b, status: 'selected' as const } : b.status === 'selected' ? { ...b, status: 'open' as const } : b); state.selectedBidId = payload.bidId; if (state.disposal) state.disposal = { ...state.disposal, status: 'selected' }; }
    if (event.type === 'salvage.disposal.failed') { if (state.disposal) state.disposal = { ...state.disposal, status: 'failed' }; state.bids = state.bids.map((b) => b.status === 'open' || b.status === 'selected' ? { ...b, status: 'lost' as const } : b); state.selectedBidId = undefined; state.status = 'ready_for_adjustment'; }
    if (event.type === 'salvage.deal.completed') { state.deal = payload.deal; if (state.disposal) state.disposal = { ...state.disposal, status: 'completed' }; state.bids = state.bids.map((b) => b.id !== payload.deal.bidId && b.status === 'open' ? { ...b, status: 'lost' as const } : b); state.status = 'ready_for_adjustment'; }
    if (event.type === 'salvage.income.posted') state.payments = [...state.payments, payload.payment];
    if (event.type === 'salvage.deal.reversed') { if (state.deal && state.deal.id === payload.dealId) state.deal = { ...state.deal, status: 'reversed', reversedAt: payload.reversedAt, reversalReason: payload.reason }; if (state.disposal) state.disposal = { ...state.disposal, status: 'collecting' }; state.bids = state.bids.map((b) => b.id === payload.bidId && b.status === 'selected' ? { ...b, status: 'open' as const } : b); if (state.selectedBidId === payload.bidId) state.selectedBidId = undefined; state.payments = state.payments.map((p) => p.sourceId === `salvage:${payload.dealId}` && p.status === 'posted' ? { ...p, status: 'voided' as const } : p); state.status = 'salvage_disposal'; }
    if (event.type === 'vehicle.ownership.updated') state.ownership = { status: payload.ownership, decidedAt: payload.decidedAt, causedBy: payload.causedBy };
    if (event.type === 'salvage.income.posted' || event.type === 'salvage.deal.reversed') state.salvageIncomeMinor = state.payments.filter((p) => p.kind === 'recovery' && p.status === 'posted' && p.sourceId.startsWith('salvage:')).reduce((sum, p) => sum - p.amount.minor, 0);
    state.audit.push({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, summary: `${event.type} accepted` });
  }
}
