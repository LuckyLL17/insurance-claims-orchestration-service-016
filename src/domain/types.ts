export type ClaimStatus =
  | 'reported'
  | 'investigating'
  | 'awaiting_documents'
  | 'ready_for_adjustment'
  | 'total_loss_candidate'
  | 'salvage_disposal'
  | 'salvage_failed'
  | 'salvage_sold'
  | 'partially_paid'
  | 'settled'
  | 'reopened'
  | 'rejected';

export type ClaimEventType =
  | 'claim.reported'
  | 'policy.snapshot.created'
  | 'evidence.added'
  | 'evidence.reviewed'
  | 'survey.assigned'
  | 'survey.completed'
  | 'documents.requested'
  | 'documents.received'
  | 'risk.assessed'
  | 'repair.estimate.recorded'
  | 'vehicle.valuation.recorded'
  | 'total_loss.basis.frozen'
  | 'total_loss.basis.superseded'
  | 'salvage.disposition.created'
  | 'salvage.disposition.superseded'
  | 'salvage.disposition.failed'
  | 'salvage.quote.received'
  | 'salvage.quote.withdrawn'
  | 'salvage.quote.expired'
  | 'salvage.quote.selected'
  | 'salvage.sale.confirmed'
  | 'salvage.sale.canceled'
  | 'vehicle.ownership.transferred'
  | 'vehicle.ownership.revoked'
  | 'payment.recovered'
  | 'payment.recovery.reversed'
  | 'adjustment.approved'
  | 'payment.authorized'
  | 'payment.settled'
  | 'payment.reversed'
  | 'claim.settled'
  | 'claim.reopened'
  | 'claim.rejected';

export interface Participant { kind: 'person' | 'vehicle' | 'device' | 'repair_shop' | 'account'; id: string; role?: string; }
export interface MonetaryAmount { currency: string; minor: number; }
export interface LossEstimate { currency: string; gross: number; deductible?: number; liabilityShare?: number; cap?: number; }
export interface PolicyVersion { policyId: string; version: number; effectiveFrom: string; effectiveTo?: string; coverages: string[]; deductibleMinor: number; limitMinor: number; }
export interface EvidenceRecord { id: string; kind: string; hash: string; version: number; receivedAt: string; reviewed: boolean; accepted?: boolean; source: string; supersedes?: string; }
export interface PaymentEntry {
  id: string;
  kind: 'authorization' | 'settlement' | 'reversal' | 'recovery' | 'recovery_reversal';
  amount: MonetaryAmount;
  sourceId: string;
  status: 'pending' | 'posted' | 'voided';
  createdAt: string;
  dispositionId?: string;
  quoteId?: string;
  basisVersion?: number;
  reversesPaymentId?: string;
}
export interface RuleSnapshot { version: string; frozenAt: string; ruleIds: string[]; }
export interface RiskSignal { code: string; score: number; explanation: string; participants: string[]; }
export interface AuditEntry { sequence: number; eventId: string; type: ClaimEventType; occurredAt: string; actor: string; summary: string; }
export interface ClaimStatusTransition { from: ClaimStatus; to: ClaimStatus; eventId: string; eventType: ClaimEventType; at: string; reason?: string; }

export type VersionStatus = 'current' | 'superseded';
export interface RepairEstimateVersion {
  version: number;
  vehicleId: string;
  amountMinor: number;
  currency: string;
  source: string;
  effectiveAt: string;
  status: VersionStatus;
  supersedesVersion?: number;
  recordedEventId?: string;
  recordedAt?: string;
}
export interface VehicleValuationVersion {
  version: number;
  vehicleId: string;
  marketValueMinor: number;
  currency: string;
  source: string;
  effectiveAt: string;
  status: VersionStatus;
  supersedesVersion?: number;
  recordedEventId?: string;
  recordedAt?: string;
}
export interface TotalLossBasis {
  basisId: string;
  version: number;
  vehicleId: string;
  estimateVersion: number;
  repairEstimateMinor: number;
  valuationVersion: number;
  marketValueMinor: number;
  currency: string;
  repairThresholdRatio: number;
  repairThresholdMinor: number;
  salvageBenchmarkMinor: number;
  candidate: boolean;
  reasons: string[];
  formula: string;
  frozenAt: string;
  status: 'frozen' | 'superseded' | 'reopened';
  frozenEventId?: string;
  supersededByBasisVersion?: number;
  dispositionId?: string;
}
export type SalvageDispositionStatus = 'open' | 'selected' | 'sold' | 'failed' | 'sale_canceled' | 'superseded';
export interface SalvageDisposition {
  id: string;
  taskId: string;
  basisVersion: number;
  valuationVersion: number;
  vehicleId: string;
  attempt: number;
  status: SalvageDispositionStatus;
  createdAt: string;
  createdEventId?: string;
  selectedQuoteId?: string;
  awardedQuoteId?: string;
  saleCallbackId?: string;
  soldAt?: string;
  failedAt?: string;
  failureReason?: string;
  canceledAt?: string;
  cancellationReason?: string;
  supersededAt?: string;
  supersededReason?: string;
}
export type SalvageQuoteStatus = 'submitted' | 'selected' | 'sold' | 'withdrawn' | 'expired' | 'declined' | 'failed' | 'superseded' | 'sale_canceled';
export interface SalvageQuote {
  id: string;
  dispositionId: string;
  basisVersion: number;
  valuationVersion: number;
  bidderId: string;
  amountMinor: number;
  currency: string;
  validUntil: string;
  status: SalvageQuoteStatus;
  receivedAt: string;
  receivedEventId?: string;
  selectedAt?: string;
  soldAt?: string;
  withdrawnAt?: string;
  expiredAt?: string;
  declinedAt?: string;
  failedAt?: string;
  saleCallbackId?: string;
  cancelCallbackId?: string;
  canceledAt?: string;
  cancellationReason?: string;
}
export interface VehicleOwnershipRecord {
  eventId: string;
  at: string;
  action: 'transferred' | 'revoked';
  vehicleId: string;
  fromOwner: string;
  toOwner: string;
  dispositionId: string;
  quoteId: string;
  documentRef?: string;
}
export interface VehicleOwnershipState {
  vehicleId: string;
  status: 'not_transferred' | 'transferred' | 'revoked';
  currentOwner?: string;
  history: VehicleOwnershipRecord[];
}
export interface AdjustmentRecord {
  eventId: string;
  sequence: number;
  kind: 'manual' | 'total_loss';
  approvedMinor: number;
  currency: string;
  marketValueMinor: number;
  deductibleMinor: number;
  salvageProceedsMinor: number;
  netEstimateMinor: number;
  basisVersion?: number;
  valuationVersion?: number;
  estimateVersion?: number;
  dispositionId?: string;
  salvageQuoteId?: string;
  recoveryPaymentId?: string;
  reason: string;
  causedByEventId?: string;
  createdAt: string;
}

export interface ClaimState {
  id: string;
  policyId: string;
  status: ClaimStatus;
  lossAt: string;
  reportedAt: string;
  channel: string;
  participants: Participant[];
  loss: LossEstimate;
  policy?: PolicyVersion;
  ruleSnapshot?: RuleSnapshot;
  evidence: EvidenceRecord[];
  requiredEvidence: Set<string>;
  completedSurveys: string[];
  pendingDocuments: string[];
  riskSignals: RiskSignal[];
  riskScore: number;
  payments: PaymentEntry[];
  approvedMinor: number;
  repairEstimates: RepairEstimateVersion[];
  vehicleValuations: VehicleValuationVersion[];
  totalLossBases: TotalLossBasis[];
  salvageDispositions: SalvageDisposition[];
  salvageQuotes: SalvageQuote[];
  vehicleOwnership?: VehicleOwnershipState;
  adjustments: AdjustmentRecord[];
  statusTransitions: ClaimStatusTransition[];
  processedCallbackIds: Set<string>;
  audit: AuditEntry[];
  processedEventIds: Set<string>;
  version: number;
}

export interface DomainEvent<T = unknown> {
  id: string;
  aggregateId: string;
  type: ClaimEventType;
  occurredAt: string;
  sequence: number;
  actor: string;
  idempotencyKey?: string;
  payload: T;
}

export interface ClaimReportedPayload {
  policyId: string; lossAt: string; reportedAt: string; channel: string;
  participants: Participant[]; loss: LossEstimate;
}

export interface RepairEstimateRecordedPayload { estimate: RepairEstimateVersion; }
export interface VehicleValuationRecordedPayload { valuation: VehicleValuationVersion; }
export interface TotalLossBasisFrozenPayload { basis: TotalLossBasis; }
export interface TotalLossBasisSupersededPayload { basisId: string; version: number; supersededByBasisVersion: number; at: string; reason: string; }
export interface SalvageDispositionCreatedPayload { disposition: SalvageDisposition; }
export interface SalvageDispositionSupersededPayload { dispositionId: string; at: string; reason: string; causedByBasisVersion?: number; }
export interface SalvageDispositionFailedPayload { dispositionId: string; at: string; reason: string; }
export interface SalvageQuoteReceivedPayload { quote: SalvageQuote; }
export interface SalvageQuoteWithdrawnPayload { quoteId: string; dispositionId: string; at: string; reason?: string; }
export interface SalvageQuoteExpiredPayload { quoteId: string; dispositionId: string; at: string; }
export interface SalvageQuoteSelectedPayload { quoteId: string; dispositionId: string; at: string; }
export interface SalvageSaleConfirmedPayload {
  callbackId: string;
  dispositionId: string;
  quoteId: string;
  bidderId: string;
  amountMinor: number;
  currency: string;
  at: string;
}
export interface SalvageSaleCanceledPayload {
  callbackId: string;
  dispositionId: string;
  quoteId: string;
  at: string;
  reason: string;
}
export interface VehicleOwnershipChangedPayload extends Omit<VehicleOwnershipRecord, 'eventId' | 'at'> { at: string; }
export interface PaymentRecoveredPayload { payment: PaymentEntry; }
export interface PaymentRecoveryReversedPayload { payment: PaymentEntry; }
