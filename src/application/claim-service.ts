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

  get(id: string): ClaimState {
    return this.replay(id, this.events.list(id));
  }

  replay(id: string, events: DomainEvent[]): ClaimState {
    const state = this.empty(id);
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) this.apply(state, event);
    if (!state.policy) throw new Error(`claim ${id} has no policy snapshot`);
    return state;
  }

  private empty(id: string): ClaimState {
    return {
      id, policyId: '', status: 'reported', lossAt: '', reportedAt: '', channel: '', participants: [], loss: { currency: 'CNY', gross: 0 },
      evidence: [], requiredEvidence: new Set(), completedSurveys: [], pendingDocuments: [], riskSignals: [], riskScore: 0,
      payments: [], approvedMinor: 0, repairEstimates: [], vehicleValuations: [], totalLossBases: [], salvageDispositions: [], salvageQuotes: [],
      adjustments: [], statusTransitions: [], processedCallbackIds: new Set(), audit: [], processedEventIds: new Set(), version: 0
    };
  }
  private assertExists(id: string): void { if (this.events.list(id).length === 0) throw new Error(`unknown claim ${id}`); }

  private apply(state: ClaimState, event: DomainEvent): void {
    if (state.processedEventIds.has(event.id)) return;
    state.processedEventIds.add(event.id); state.version = event.sequence;
    const fromStatus = state.status;
    const payload = event.payload as any;

    if (event.type === 'claim.reported') {
      state.policyId = payload.policyId; state.lossAt = payload.lossAt; state.reportedAt = payload.reportedAt;
      state.channel = payload.channel; state.participants = payload.participants; state.loss = payload.loss; state.status = 'reported';
    }
    if (event.type === 'policy.snapshot.created') { state.policy = payload.policy; state.ruleSnapshot = payload.ruleSnapshot; }
    if (event.type === 'evidence.added') {
      state.evidence = [...state.evidence.filter((e) => e.id !== payload.evidence.id), payload.evidence];
      state.status = state.status === 'reported' ? 'investigating' : state.status;
    }
    if (event.type === 'evidence.reviewed') { state.evidence = state.evidence.map((e) => e.id === payload.evidence.id ? payload.evidence : e); }
    if (event.type === 'documents.requested') {
      state.pendingDocuments = [...new Set([...(state.pendingDocuments), ...(payload.kinds ?? [])])]; state.status = 'awaiting_documents';
    }
    if (event.type === 'documents.received') {
      state.pendingDocuments = state.pendingDocuments.filter((kind) => !(payload.kinds ?? []).includes(kind));
      if (!state.pendingDocuments.length) state.status = 'ready_for_adjustment';
    }
    if (event.type === 'survey.completed') { state.completedSurveys = [...new Set([...state.completedSurveys, payload.taskId])]; }
    if (event.type === 'risk.assessed') { state.riskSignals = payload.signals; state.riskScore = payload.score; }

    if (event.type === 'repair.estimate.recorded') {
      const incoming = { ...payload.estimate, recordedEventId: event.id };
      state.repairEstimates = state.repairEstimates.map((item) =>
        item.vehicleId === incoming.vehicleId && item.version < incoming.version
          ? { ...item, status: 'superseded' as const, supersedesVersion: incoming.version }
          : item
      );
      state.repairEstimates = [...state.repairEstimates.filter((item) => !(item.vehicleId === incoming.vehicleId && item.version === incoming.version)), incoming];
    }
    if (event.type === 'vehicle.valuation.recorded') {
      const incoming = { ...payload.valuation, recordedEventId: event.id };
      state.vehicleValuations = state.vehicleValuations.map((item) =>
        item.vehicleId === incoming.vehicleId && item.version < incoming.version
          ? { ...item, status: 'superseded' as const, supersedesVersion: incoming.version }
          : item
      );
      state.vehicleValuations = [...state.vehicleValuations.filter((item) => !(item.vehicleId === incoming.vehicleId && item.version === incoming.version)), incoming];
    }
    if (event.type === 'total_loss.basis.frozen') {
      const incoming = { ...payload.basis, frozenEventId: event.id };
      state.totalLossBases = [...state.totalLossBases.filter((item) => item.version !== incoming.version), incoming];
      state.status = incoming.candidate ? 'total_loss_candidate' : 'ready_for_adjustment';
    }
    if (event.type === 'total_loss.basis.superseded') {
      state.totalLossBases = state.totalLossBases.map((basis) => basis.version === payload.version ? {
        ...basis,
        status: 'superseded' as const,
        supersededByBasisVersion: payload.supersededByBasisVersion
      } : basis);
    }
    if (event.type === 'salvage.disposition.created') {
      const incoming = { ...payload.disposition, createdEventId: event.id };
      state.salvageDispositions = [...state.salvageDispositions.filter((item) => item.id !== incoming.id), incoming];
      state.status = 'salvage_disposal';
    }
    if (event.type === 'salvage.disposition.superseded') {
      state.salvageDispositions = state.salvageDispositions.map((item) => item.id === payload.dispositionId ? {
        ...item,
        status: 'superseded' as const,
        supersededAt: payload.at,
        supersededReason: payload.reason
      } : item);
      state.salvageQuotes = state.salvageQuotes.map((quote) => quote.dispositionId === payload.dispositionId && !['sold', 'superseded'].includes(quote.status)
        ? { ...quote, status: 'superseded' as const }
        : quote);
      state.totalLossBases = state.totalLossBases.map((basis) => basis.dispositionId === payload.dispositionId ? { ...basis, dispositionId: undefined } : basis);
    }
    if (event.type === 'salvage.disposition.failed') {
      state.salvageDispositions = state.salvageDispositions.map((item) => item.id === payload.dispositionId ? { ...item, status: 'failed' as const, failedAt: payload.at, failureReason: payload.reason } : item);
      state.salvageQuotes = state.salvageQuotes.map((quote) => {
        if (quote.dispositionId !== payload.dispositionId) return quote;
        if (quote.status === 'selected') return { ...quote, status: 'failed' as const, failedAt: payload.at };
        if (quote.status === 'submitted') return { ...quote, status: 'declined' as const, declinedAt: payload.at };
        return quote;
      });
      state.status = 'salvage_failed';
    }
    if (event.type === 'salvage.quote.received') {
      const incoming = { ...payload.quote, receivedEventId: event.id };
      state.salvageQuotes = [...state.salvageQuotes.filter((item) => item.id !== incoming.id), incoming];
    }
    if (event.type === 'salvage.quote.withdrawn') {
      state.salvageQuotes = state.salvageQuotes.map((quote) => quote.id === payload.quoteId ? { ...quote, status: 'withdrawn' as const, withdrawnAt: payload.at } : quote);
    }
    if (event.type === 'salvage.quote.expired') {
      state.salvageQuotes = state.salvageQuotes.map((quote) => quote.id === payload.quoteId && quote.status === 'submitted' ? { ...quote, status: 'expired' as const, expiredAt: payload.at } : quote);
    }
    if (event.type === 'salvage.quote.selected') {
      const selected = state.salvageQuotes.find((quote) => quote.id === payload.quoteId);
      state.salvageQuotes = state.salvageQuotes.map((quote) => {
        if (quote.dispositionId !== payload.dispositionId) return quote;
        if (quote.id === payload.quoteId) return { ...quote, status: 'selected' as const, selectedAt: payload.at };
        return ['selected', 'submitted'].includes(quote.status) ? { ...quote, status: 'declined' as const, declinedAt: payload.at } : quote;
      });
      state.salvageDispositions = state.salvageDispositions.map((item) => item.id === payload.dispositionId ? { ...item, status: 'selected' as const, selectedQuoteId: payload.quoteId } : item);
      if (selected) state.totalLossBases = state.totalLossBases.map((basis) => basis.version === selected.basisVersion ? { ...basis, dispositionId: payload.dispositionId } : basis);
    }
    if (event.type === 'salvage.sale.confirmed') {
      state.processedCallbackIds.add(payload.callbackId);
      state.salvageQuotes = state.salvageQuotes.map((quote) => quote.id === payload.quoteId ? { ...quote, status: 'sold' as const, soldAt: payload.at, saleCallbackId: payload.callbackId } : quote);
      state.salvageDispositions = state.salvageDispositions.map((item) => item.id === payload.dispositionId ? { ...item, status: 'sold' as const, awardedQuoteId: payload.quoteId, soldAt: payload.at, saleCallbackId: payload.callbackId } : item);
      state.status = 'salvage_sold';
    }
    if (event.type === 'salvage.sale.canceled') {
      state.processedCallbackIds.add(payload.callbackId);
      state.salvageQuotes = state.salvageQuotes.map((quote) => quote.id === payload.quoteId ? { ...quote, status: 'sale_canceled' as const, canceledAt: payload.at, cancelCallbackId: payload.callbackId, cancellationReason: payload.reason } : quote);
      state.salvageDispositions = state.salvageDispositions.map((item) => item.id === payload.dispositionId ? { ...item, status: 'sale_canceled' as const, canceledAt: payload.at, cancellationReason: payload.reason, selectedQuoteId: undefined } : item);
      if (state.status === 'salvage_sold') state.status = 'salvage_disposal';
    }
    if (event.type === 'vehicle.ownership.transferred') {
      const vehicleId = payload.vehicleId;
      state.vehicleOwnership = {
        vehicleId,
        status: 'transferred',
        currentOwner: payload.toOwner,
        history: [...(state.vehicleOwnership?.history ?? []), { ...payload, eventId: event.id }]
      };
    }
    if (event.type === 'vehicle.ownership.revoked') {
      const history = [...(state.vehicleOwnership?.history ?? [])];
      const previous = history.reverse().find((record) => record.quoteId === payload.quoteId && record.action === 'transferred');
      state.vehicleOwnership = {
        vehicleId: payload.vehicleId,
        status: 'revoked',
        currentOwner: previous?.fromOwner,
        history: [...(state.vehicleOwnership?.history ?? []), { ...payload, eventId: event.id }]
      };
    }
    if (event.type === 'payment.recovered' || event.type === 'payment.recovery.reversed') {
      state.payments = [...state.payments, payload.payment];
    }
    if (event.type === 'adjustment.approved') {
      state.approvedMinor = payload.approvedMinor;
      state.requiredEvidence = new Set(payload.requiredEvidence ?? []);
      if (payload.adjustment) state.adjustments = [...state.adjustments, { ...payload.adjustment, eventId: event.id }];
      if (state.salvageDispositions.some((item) => item.status === 'sold')) state.status = 'salvage_sold';
      else if (state.salvageDispositions.some((item) => item.status === 'sale_canceled')) state.status = 'salvage_disposal';
      else state.status = 'ready_for_adjustment';
    }
    if (event.type === 'payment.settled' || event.type === 'payment.reversed') {
      state.payments = [...state.payments, payload.payment]; state.status = payload.payment.kind === 'reversal' ? 'reopened' : 'partially_paid';
    }
    if (event.type === 'claim.reopened' && payload.basisVersions) {
      for (const basis of state.totalLossBases) if (payload.basisVersions.includes(basis.version)) basis.status = 'reopened';
    }
    if (event.type === 'claim.reopened') state.status = 'reopened';
    if (event.type === 'claim.settled') state.status = 'settled';
    if (event.type === 'claim.rejected') state.status = 'rejected';
    if (state.status !== fromStatus) state.statusTransitions.push({
      from: fromStatus,
      to: state.status,
      eventId: event.id,
      eventType: event.type,
      at: event.occurredAt,
      reason: payload.reason
    });
    state.audit.push({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, summary: `${event.type} accepted` });
  }
}
