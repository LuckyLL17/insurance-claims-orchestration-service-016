import { EventStore } from './event-store';
import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
import { TaskBoard } from '../domain/task';
import { TotalLossPolicy } from '../domain/total-loss';
import { newId, iso } from '../domain/ids';
import {
  ClaimState,
  DomainEvent,
  SalvageDisposition,
  SalvageQuote,
  TotalLossBasis
} from '../domain/types';

export interface VehicleVersionInput {
  vehicleId: string;
  amount?: number;
  amountMinor?: number;
  currency?: string;
  source: string;
  effectiveAt?: string;
  at?: string;
}

export interface SalvageQuoteInput {
  dispositionId?: string;
  bidderId: string;
  amount: number;
  currency?: string;
  validUntil: string;
  at?: string;
}

export interface SaleCallbackInput {
  callbackId: string;
  dispositionId?: string;
  quoteId: string;
  amountMinor: number;
  currency?: string;
  fromOwner?: string;
  documentRef?: string;
  at?: string;
}

export class TotalLossService {
  constructor(
    private readonly events: EventStore,
    private readonly claims: ClaimService,
    private readonly tasks: TaskBoard,
    private readonly ledger: PaymentLedger,
    private readonly policy: TotalLossPolicy = new TotalLossPolicy()
  ) {}

  recordRepairEstimate(claimId: string, input: VehicleVersionInput, actor: string, key?: string): ClaimState {
    const claim = this.claims.get(claimId);
    this.assertWritable(claim);
    const amountMinor = this.amountMinor(input);
    const current = this.policy.currentRepairEstimate(claim, input.vehicleId);
    if (current && current.amountMinor === amountMinor && current.source === input.source) return claim;
    const estimate = {
      version: this.nextVersion(claim.repairEstimates, input.vehicleId),
      vehicleId: input.vehicleId,
      amountMinor,
      currency: input.currency ?? claim.loss.currency,
      source: input.source,
      effectiveAt: iso(input.effectiveAt ?? input.at),
      status: 'current' as const
    };
    return this.claims.addEvent(claimId, 'repair.estimate.recorded', { estimate }, actor, key ?? `repair:${claimId}:${estimate.version}`, input.at);
  }

  recordVehicleValuation(claimId: string, input: VehicleVersionInput, actor: string, key?: string): ClaimState {
    const claim = this.claims.get(claimId);
    this.assertWritable(claim);
    const amountMinor = this.amountMinor(input);
    const current = this.policy.currentValuation(claim, input.vehicleId);
    if (current && current.marketValueMinor === amountMinor && current.source === input.source) return claim;
    const valuation = {
      version: this.nextVersion(claim.vehicleValuations, input.vehicleId),
      vehicleId: input.vehicleId,
      marketValueMinor: amountMinor,
      currency: input.currency ?? claim.loss.currency,
      source: input.source,
      effectiveAt: iso(input.effectiveAt ?? input.at),
      status: 'current' as const
    };
    return this.claims.addEvent(claimId, 'vehicle.valuation.recorded', { valuation }, actor, key ?? `valuation:${claimId}:${valuation.version}`, input.at);
  }

  assess(claimId: string, input: { vehicleId: string; repairThresholdRatio: number; salvageBenchmarkMinor?: number; at?: string }, actor: string, key?: string): ClaimState {
    let claim = this.claims.get(claimId);
    this.assertWritable(claim);
    const currentBasis = this.policy.currentBasis(claim, input.vehicleId);
    const estimate = this.policy.currentRepairEstimate(claim, input.vehicleId);
    const valuation = this.policy.currentValuation(claim, input.vehicleId);
    const activeDisposition = claim.salvageDispositions
      .filter((item) => item.basisVersion === currentBasis?.version && !['superseded'].includes(item.status))
      .at(-1);
    if (currentBasis && estimate && valuation && currentBasis.estimateVersion === estimate.version && currentBasis.valuationVersion === valuation.version && currentBasis.repairThresholdRatio === input.repairThresholdRatio) {
      return claim;
    }
    if (activeDisposition?.status === 'sold') throw new Error('sold salvage cannot be reassessed until the claim is reopened');

    const frozenAt = iso(input.at);
    const basisVersion = claim.totalLossBases.length + 1;
    const basis = this.policy.freeze(claim, {
      vehicleId: input.vehicleId,
      repairAmount: (estimate?.amountMinor ?? 0) / 100,
      marketValue: (valuation?.marketValueMinor ?? 0) / 100,
      repairThresholdRatio: input.repairThresholdRatio,
      salvageBenchmarkMinor: input.salvageBenchmarkMinor
    }, basisVersion, frozenAt);

    for (const old of claim.totalLossBases.filter((item) => item.vehicleId === input.vehicleId && item.status !== 'superseded')) {
      claim = this.claims.addEvent(claimId, 'total_loss.basis.superseded', {
        basisId: old.basisId,
        version: old.version,
        supersededByBasisVersion: basisVersion,
        at: frozenAt,
        reason: `superseded by basis version ${basisVersion}`
      }, actor, `supersede-basis:${old.version}:${basisVersion}`, input.at);
    }
    claim = this.claims.addEvent(claimId, 'total_loss.basis.frozen', { basis }, actor, key ?? `basis:${claimId}:${basisVersion}`, input.at);

    for (const disposition of claim.salvageDispositions.filter((item) => item.basisVersion !== basisVersion && !['superseded', 'sold'].includes(item.status))) {
      claim = this.claims.addEvent(claimId, 'salvage.disposition.superseded', { dispositionId: disposition.id, at: frozenAt, reason: `frozen basis version ${basisVersion}`, causedByBasisVersion: basisVersion }, actor, `supersede-disposition:${disposition.id}:${basisVersion}`, input.at);
    }

    if (basis.candidate) claim = this.createDisposition(claimId, { vehicleId: input.vehicleId, basisVersion, at: input.at }, actor);
    return claim;
  }

  createDisposition(claimId: string, input: { vehicleId?: string; basisVersion?: number; at?: string }, actor: string): ClaimState {
    const claim = this.claims.get(claimId);
    this.assertWritable(claim);
    const basis = input.basisVersion ? this.policy.basisByVersion(claim, input.basisVersion) : this.policy.currentBasis(claim, input.vehicleId);
    if (!basis || basis.status !== 'frozen') throw new Error('a frozen current total loss basis is required');
    if (!basis.candidate) throw new Error(`basis version ${basis.version} is not a total loss candidate`);
    const latest = claim.salvageDispositions.filter((item) => item.basisVersion === basis.version).at(-1);
    if (latest && !['failed', 'sale_canceled', 'superseded'].includes(latest.status)) throw new Error(`disposition ${latest.id} is already ${latest.status}`);
    const task = this.tasks.create(claimId, 'salvage_disposal');
    const disposition: SalvageDisposition = {
      id: newId('salvage'),
      taskId: task.id,
      basisVersion: basis.version,
      valuationVersion: basis.valuationVersion,
      vehicleId: basis.vehicleId,
      attempt: claim.salvageDispositions.filter((item) => item.basisVersion === basis.version).length + 1,
      status: 'open',
      createdAt: iso(input.at)
    };
    return this.claims.addEvent(claimId, 'salvage.disposition.created', { disposition }, actor, `disposition:${disposition.id}`, input.at);
  }

  receiveQuote(claimId: string, input: SalvageQuoteInput, actor: string, key?: string): ClaimState {
    const claim = this.claims.get(claimId);
    this.assertWritable(claim);
    const disposition = this.resolveDisposition(claim, input.dispositionId);
    if (disposition.status !== 'open') throw new Error(`disposition ${disposition.id} is ${disposition.status}`);
    const at = iso(input.at);
    if (!input.bidderId) throw new Error('bidder id is required');
    if (new Date(iso(input.validUntil)).getTime() <= new Date(at).getTime()) throw new Error('quote is already expired');
    const amountMinor = Math.round(input.amount * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('quote amount must be positive');
    const duplicate = claim.salvageQuotes.find((quote) => quote.dispositionId === disposition.id && quote.bidderId === input.bidderId && quote.amountMinor === amountMinor && quote.validUntil === iso(input.validUntil));
    if (duplicate) return claim;
    const quote: SalvageQuote = {
      id: newId('salvage_quote'),
      dispositionId: disposition.id,
      basisVersion: disposition.basisVersion,
      valuationVersion: disposition.valuationVersion,
      bidderId: input.bidderId,
      amountMinor,
      currency: input.currency ?? claim.loss.currency,
      validUntil: iso(input.validUntil),
      status: 'submitted',
      receivedAt: at
    };
    return this.claims.addEvent(claimId, 'salvage.quote.received', { quote }, actor, key ?? `quote:${claimId}:${quote.id}`, input.at);
  }

  withdrawQuote(claimId: string, quoteId: string, input: { at?: string; reason?: string } = {}, actor: string): ClaimState {
    const claim = this.claims.get(claimId);
    this.assertWritable(claim);
    const quote = this.policy.quoteById(claim, quoteId);
    const disposition = this.policy.dispositionById(claim, quote.dispositionId);
    if (disposition.status !== 'open' || quote.status !== 'submitted') throw new Error(`quote ${quoteId} cannot be withdrawn while ${quote.status}`);
    return this.claims.addEvent(claimId, 'salvage.quote.withdrawn', { quoteId, dispositionId: disposition.id, at: iso(input.at), reason: input.reason }, actor, `withdraw-quote:${quoteId}`, input.at);
  }

  expireQuotes(claimId: string, dispositionId: string | undefined, input: { at?: string } = {}, actor: string): ClaimState {
    let claim = this.claims.get(claimId);
    const at = iso(input.at);
    const disposition = this.resolveDisposition(claim, dispositionId);
    const candidates = claim.salvageQuotes.filter((quote) => quote.dispositionId === disposition.id && quote.status === 'submitted' && new Date(quote.validUntil).getTime() <= new Date(at).getTime());
    for (const quote of candidates) {
      claim = this.claims.addEvent(claimId, 'salvage.quote.expired', { quoteId: quote.id, dispositionId: disposition.id, at }, actor, `expire-quote:${quote.id}`, input.at);
    }
    return claim;
  }

  selectQuote(claimId: string, quoteId: string, input: { at?: string } = {}, actor: string): ClaimState {
    const claim = this.claims.get(claimId);
    this.assertWritable(claim);
    const quote = this.policy.quoteById(claim, quoteId);
    const disposition = this.policy.dispositionById(claim, quote.dispositionId);
    if (disposition.status !== 'open') throw new Error(`disposition ${disposition.id} is ${disposition.status}`);
    this.policy.ensureQuoteUsable(claim, disposition, quote, iso(input.at));
    return this.claims.addEvent(claimId, 'salvage.quote.selected', { quoteId, dispositionId: disposition.id, at: iso(input.at) }, actor, `select-quote:${quoteId}:${quote.basisVersion}`, input.at);
  }

  failDisposition(claimId: string, dispositionId: string, input: { at?: string; reason?: string } = {}, actor: string): ClaimState {
    const claim = this.claims.get(claimId);
    this.assertWritable(claim);
    const disposition = this.policy.dispositionById(claim, dispositionId);
    if (!['open', 'selected'].includes(disposition.status)) throw new Error(`disposition ${dispositionId} cannot fail while ${disposition.status}`);
    const valid = claim.salvageQuotes.some((quote) => quote.dispositionId === dispositionId && (quote.status === 'selected' || (quote.status === 'submitted' && new Date(quote.validUntil).getTime() > new Date(iso(input.at)).getTime())));
    if (valid) throw new Error('a live quote remains; withdraw or expire it before marking the disposition failed');
    return this.claims.addEvent(claimId, 'salvage.disposition.failed', { dispositionId, at: iso(input.at), reason: input.reason ?? 'no accepted salvage bid' }, actor, `fail-disposition:${dispositionId}`, input.at);
  }

  confirmSale(claimId: string, input: SaleCallbackInput, actor: string): ClaimState {
    let claim = this.claims.get(claimId);
    if (claim.processedCallbackIds.has(input.callbackId)) return claim;
    this.assertWritable(claim);
    const quote = this.policy.quoteById(claim, input.quoteId);
    const disposition = this.policy.dispositionById(claim, quote.dispositionId);
    if (input.dispositionId && input.dispositionId !== disposition.id) throw new Error('callback disposition does not match the selected quote');
    if (disposition.status !== 'selected' || disposition.selectedQuoteId !== quote.id || quote.status !== 'selected') throw new Error(`quote ${quote.id} is not the selected live quote`);
    if (quote.amountMinor !== input.amountMinor || quote.currency !== (input.currency ?? claim.loss.currency)) throw new Error('callback amount does not match the frozen selected quote');
    const at = iso(input.at);
    const bidder = claim.participants.find((participant) => participant.kind === 'person');
    const fromOwner = input.fromOwner ?? bidder?.id ?? 'policyholder';

    claim = this.claims.addEvent(claimId, 'salvage.sale.confirmed', {
      callbackId: input.callbackId, dispositionId: disposition.id, quoteId: quote.id, bidderId: quote.bidderId,
      amountMinor: quote.amountMinor, currency: quote.currency, at
    }, actor, `sale-callback:${input.callbackId}`, input.at);

    claim = this.claims.addEvent(claimId, 'vehicle.ownership.transferred', {
      vehicleId: disposition.vehicleId, fromOwner, toOwner: quote.bidderId,
      dispositionId: disposition.id, quoteId: quote.id, documentRef: input.documentRef, action: 'transferred'
    }, actor, `ownership:${input.callbackId}`, input.at);

    const payment = this.ledger.postMinor(claim.payments, {
      kind: 'recovery',
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      sourceId: `salvage-recovery:${disposition.id}:${quote.id}:${input.callbackId}`,
      dispositionId: disposition.id,
      quoteId: quote.id,
      basisVersion: disposition.basisVersion
    });
    claim = this.claims.addEvent(claimId, 'payment.recovered', { payment }, actor, `recovery-payment:${input.callbackId}`, input.at);
    const recoveredEventId = claim.audit.at(-1)?.eventId;

    const basis = this.policy.basisByVersion(claim, disposition.basisVersion);
    const gross = this.policy.grossApprovedMinor(claim, basis);
    const netEstimateMinor = Math.max(0, gross - quote.amountMinor);
    claim = this.claims.addEvent(claimId, 'adjustment.approved', {
      approvedMinor: netEstimateMinor,
      requiredEvidence: [...claim.requiredEvidence],
      adjustment: {
        sequence: claim.adjustments.length + 1,
        kind: 'total_loss',
        approvedMinor: netEstimateMinor,
        currency: quote.currency,
        marketValueMinor: basis.marketValueMinor,
        deductibleMinor: claim.policy?.deductibleMinor ?? 0,
        salvageProceedsMinor: quote.amountMinor,
        netEstimateMinor,
        basisVersion: basis.version,
        valuationVersion: basis.valuationVersion,
        estimateVersion: basis.estimateVersion,
        dispositionId: disposition.id,
        salvageQuoteId: quote.id,
        recoveryPaymentId: payment.id,
        reason: `total loss net approval after salvage sale ${input.callbackId}`,
        causedByEventId: recoveredEventId,
        createdAt: at
      }
    }, actor, `total-loss-adjustment:${input.callbackId}`, input.at);
    return claim;
  }

  cancelSale(claimId: string, input: { callbackId: string; dispositionId?: string; quoteId: string; at?: string; reason: string }, actor: string): ClaimState {
    let claim = this.claims.get(claimId);
    if (claim.processedCallbackIds.has(input.callbackId)) return claim;
    this.assertWritable(claim);
    const quote = this.policy.quoteById(claim, input.quoteId);
    const disposition = this.policy.dispositionById(claim, quote.dispositionId);
    if (input.dispositionId && input.dispositionId !== disposition.id) throw new Error('callback disposition does not match quote');
    if (disposition.status !== 'sold' || disposition.awardedQuoteId !== quote.id || quote.status !== 'sold') throw new Error(`sale for quote ${quote.id} is not sold`);
    const priorRecovery = [...claim.payments].reverse().find((payment) => payment.kind === 'recovery' && payment.dispositionId === disposition.id && payment.quoteId === quote.id);
    if (!priorRecovery) throw new Error(`recovery payment for sale ${disposition.id} was not found`);
    const at = iso(input.at);

    claim = this.claims.addEvent(claimId, 'salvage.sale.canceled', {
      callbackId: input.callbackId, dispositionId: disposition.id, quoteId: quote.id, at, reason: input.reason
    }, actor, `cancel-sale-callback:${input.callbackId}`, input.at);

    claim = this.claims.addEvent(claimId, 'vehicle.ownership.revoked', {
      vehicleId: disposition.vehicleId,
      fromOwner: quote.bidderId,
      toOwner: [...(claim.vehicleOwnership?.history ?? [])].reverse().find((record) => record.action === 'transferred' && record.quoteId === quote.id)?.fromOwner ?? 'policyholder',
      dispositionId: disposition.id,
      quoteId: quote.id,
      documentRef: input.callbackId,
      action: 'revoked'
    }, actor, `revoke-ownership:${input.callbackId}`, input.at);

    const reversal = this.ledger.postMinor(claim.payments, {
      kind: 'recovery_reversal',
      amountMinor: Math.abs(priorRecovery.amount.minor),
      currency: priorRecovery.amount.currency,
      sourceId: `salvage-recovery-reversal:${disposition.id}:${quote.id}:${input.callbackId}`,
      dispositionId: disposition.id,
      quoteId: quote.id,
      basisVersion: disposition.basisVersion,
      reversesPaymentId: priorRecovery.id
    });
    claim = this.claims.addEvent(claimId, 'payment.recovery.reversed', { payment: reversal }, actor, `recovery-reversal:${input.callbackId}`, input.at);

    const basis = this.policy.basisByVersion(claim, disposition.basisVersion);
    const gross = this.policy.grossApprovedMinor(claim, basis);
    claim = this.claims.addEvent(claimId, 'adjustment.approved', {
      approvedMinor: gross,
      requiredEvidence: [...claim.requiredEvidence],
      adjustment: {
        sequence: claim.adjustments.length + 1,
        kind: 'total_loss',
        approvedMinor: gross,
        currency: priorRecovery.amount.currency,
        marketValueMinor: basis.marketValueMinor,
        deductibleMinor: claim.policy?.deductibleMinor ?? 0,
        salvageProceedsMinor: 0,
        netEstimateMinor: gross,
        basisVersion: basis.version,
        valuationVersion: basis.valuationVersion,
        estimateVersion: basis.estimateVersion,
        dispositionId: disposition.id,
        salvageQuoteId: quote.id,
        recoveryPaymentId: reversal.id,
        reason: `salvage sale revoked: ${input.reason}`,
        causedByEventId: claim.audit.at(-1)?.eventId,
        createdAt: at
      }
    }, actor, `total-loss-adjustment-reversal:${input.callbackId}`, input.at);
    return claim;
  }

  reopen(claimId: string, input: { at?: string; reason: string }, actor: string): ClaimState {
    const claim = this.claims.get(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be reopened');
    const currentBases = claim.totalLossBases.filter((basis) => basis.status === 'frozen' || basis.status === 'reopened').map((basis) => basis.version);
    return this.claims.addEvent(claimId, 'claim.reopened', { reason: input.reason, basisVersions: currentBases, at: iso(input.at) }, actor, `reopen:${claim.id}:${claim.version}`, input.at);
  }

  query(claimId: string) {
    const claim = this.claims.get(claimId);
    const currentBasis = this.policy.currentBasis(claim);
    const currentDisposition = currentBasis ? claim.salvageDispositions.filter((item) => item.basisVersion === currentBasis.version && item.status !== 'superseded').at(-1) : undefined;
    const currentQuoteIds = new Set(claim.salvageQuotes.filter((quote) => currentDisposition && quote.dispositionId === currentDisposition.id).map((quote) => quote.id));
    return {
      status: claim.status,
      statusTransitions: claim.statusTransitions,
      stateMachine: this.policy.statusTransitions(),
      currentRepairEstimate: this.latestCurrent(claim.repairEstimates),
      currentVehicleValuation: this.latestCurrent(claim.vehicleValuations),
      currentBasis,
      currentDisposition,
      currentQuotes: claim.salvageQuotes.filter((quote) => currentQuoteIds.has(quote.id)),
      historicalBases: claim.totalLossBases.filter((basis) => basis !== currentBasis),
      historicalDispositions: claim.salvageDispositions.filter((item) => item !== currentDisposition),
      vehicleOwnership: claim.vehicleOwnership,
      latestAdjustment: claim.adjustments.at(-1),
      approval: {
        approvedMinor: claim.approvedMinor,
        claimantPaidMinor: this.ledger.claimantSettlementBalance(claim.payments),
        salvageRecoveryMinor: this.ledger.recoveryBalance(claim.payments),
        ledgerBalanceMinor: this.ledger.balance(claim.payments)
      }
    };
  }

  causality(claimId: string) {
    const claim = this.claims.get(claimId);
    const events = this.events.list(claimId);
    const links: Array<{ fromEventId: string; toEventId: string; relation: string; reason: string }> = [];
    const add = (from: DomainEvent | undefined, to: DomainEvent, relation: string, reason: string) => { if (from) links.push({ fromEventId: from.id, toEventId: to.id, relation, reason }); };
    const estimateEvents = new Map<string, DomainEvent>();
    const valuationEvents = new Map<string, DomainEvent>();
    const basisEvents = new Map<number, DomainEvent>();
    const dispositionEvents = new Map<string, DomainEvent>();
    const quoteReceivedEvents = new Map<string, DomainEvent>();
    const selectedByQuote = new Map<string, DomainEvent>();
    const saleByQuote = new Map<string, DomainEvent>();
    const saleByDisposition = new Map<string, DomainEvent>();
    const recoveryByDisposition = new Map<string, DomainEvent>();

    for (const event of events) {
      const p = event.payload as any;
      if (event.type === 'repair.estimate.recorded') estimateEvents.set(`${p.estimate.vehicleId}:${p.estimate.version}`, event);
      if (event.type === 'vehicle.valuation.recorded') valuationEvents.set(`${p.valuation.vehicleId}:${p.valuation.version}`, event);
      if (event.type === 'total_loss.basis.frozen' && p.basis) {
        basisEvents.set(p.basis.version, event);
        add(estimateEvents.get(`${p.basis.vehicleId}:${p.basis.estimateVersion}`), event, 'freeze', 'frozen repair estimate');
        add(valuationEvents.get(`${p.basis.vehicleId}:${p.basis.valuationVersion}`), event, 'freeze', 'frozen vehicle valuation');
      }
      if (event.type === 'salvage.disposition.created') {
        dispositionEvents.set(p.disposition.id, event);
        add(basisEvents.get(p.disposition.basisVersion), event, 'creates_task', 'disposition created from frozen basis');
      }
      if (event.type === 'salvage.quote.received') {
        quoteReceivedEvents.set(p.quote.id, event);
        add(dispositionEvents.get(p.quote.dispositionId), event, 'receives', 'quote belongs to disposition');
      }
      if (event.type === 'salvage.quote.selected') {
        add(quoteReceivedEvents.get(p.quoteId), event, 'selects', 'selected quote');
        selectedByQuote.set(p.quoteId, event);
      }
      if (event.type === 'salvage.sale.confirmed') {
        add(selectedByQuote.get(p.quoteId), event, 'callback', 'sale callback for selected quote');
        add(quoteReceivedEvents.get(p.quoteId), event, 'awards', 'sale completes received quote');
        saleByQuote.set(p.quoteId, event);
        saleByDisposition.set(p.dispositionId, event);
      }
      if (event.type === 'vehicle.ownership.transferred') {
        add(saleByDisposition.get(p.dispositionId), event, 'transfers_ownership', 'ownership follows completed sale');
      }
      if (event.type === 'payment.recovered') {
        add(saleByDisposition.get(p.payment.dispositionId), event, 'pays_salvage', 'salvage recovery follows sale callback');
        recoveryByDisposition.set(p.payment.dispositionId, event);
      }
      if (event.type === 'adjustment.approved' && p.adjustment) {
        add(recoveryByDisposition.get(p.adjustment.dispositionId), event, 'offsets_approval', 'salvage income offsets total loss approval');
        add(basisEvents.get(p.adjustment.basisVersion), event, 'approves_against', 'approval uses frozen basis');
      }
      if (event.type === 'salvage.sale.canceled') {
        add(saleByQuote.get(p.quoteId), event, 'cancels', 'post-sale cancellation');
        saleByDisposition.set(p.dispositionId, event);
      }
      if (event.type === 'vehicle.ownership.revoked') add(saleByDisposition.get(p.dispositionId), event, 'revokes_ownership', 'ownership revoked with sale');
      if (event.type === 'payment.recovery.reversed') {
        add(recoveryByDisposition.get(p.payment.dispositionId), event, 'reverses_recovery', 'cancellation reverses salvage recovery');
        recoveryByDisposition.set(p.payment.dispositionId, event);
      }
      if (event.type === 'claim.reopened') {
        for (const version of p.basisVersions ?? []) add(basisEvents.get(version), event, 'reopens', 'claim reopening unlocks basis');
      }
    }

    return { claimId, events, links, state: claim, linkCount: links.length };
  }

  private resolveDisposition(claim: ClaimState, dispositionId?: string): SalvageDisposition {
    if (dispositionId) return this.policy.dispositionById(claim, dispositionId);
    const disposition = this.policy.currentDisposition(claim);
    if (!disposition) throw new Error('no active salvage disposition');
    return disposition;
  }

  private latestCurrent<T extends { vehicleId: string; version: number; status: string }>(items: T[]): T | undefined {
    return items.filter((item) => item.status === 'current').at(-1);
  }

  private nextVersion(items: Array<{ vehicleId: string; version: number }>, vehicleId: string): number {
    return Math.max(0, ...items.filter((item) => item.vehicleId === vehicleId).map((item) => item.version)) + 1;
  }

  private amountMinor(input: VehicleVersionInput): number {
    if (input.amountMinor !== undefined) {
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('amountMinor must be a positive integer');
      return input.amountMinor;
    }
    if (input.amount === undefined) throw new Error('amount or amountMinor is required');
    const minor = Math.round(input.amount * 100);
    if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error('amount must be positive');
    return minor;
  }

  private assertWritable(claim: ClaimState): void {
    if (claim.status === 'rejected') throw new Error('rejected claim is read-only');
  }
}
