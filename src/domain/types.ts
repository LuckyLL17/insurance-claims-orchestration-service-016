export type ClaimStatus =
  | 'reported'
  | 'investigating'
  | 'awaiting_documents'
  | 'ready_for_adjustment'
  | 'total_loss_candidate'
  | 'salvage_disposal'
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
  | 'vehicle.valuation.recorded'
  | 'total_loss.evaluated'
  | 'salvage.disposal.started'
  | 'salvage.bid.received'
  | 'salvage.bid.withdrawn'
  | 'salvage.bid.expired'
  | 'salvage.bid.selected'
  | 'salvage.disposal.failed'
  | 'salvage.deal.completed'
  | 'salvage.deal.reversed'
  | 'salvage.income.posted'
  | 'vehicle.ownership.updated'
  | 'adjustment.approved'
  | 'payment.authorized'
  | 'payment.settled'
  | 'payment.reversed'
  | 'claim.reopened'
  | 'claim.rejected';

export interface Participant { kind: 'person' | 'vehicle' | 'device' | 'repair_shop' | 'account'; id: string; role?: string; }
export interface MonetaryAmount { currency: string; minor: number; }
export interface LossEstimate { currency: string; gross: number; deductible?: number; liabilityShare?: number; cap?: number; }
export interface PolicyVersion { policyId: string; version: number; effectiveFrom: string; effectiveTo?: string; coverages: string[]; deductibleMinor: number; limitMinor: number; }
export interface EvidenceRecord { id: string; kind: string; hash: string; version: number; receivedAt: string; reviewed: boolean; accepted?: boolean; source: string; supersedes?: string; }
export interface PaymentEntry { id: string; kind: 'authorization' | 'settlement' | 'reversal' | 'recovery'; amount: MonetaryAmount; sourceId: string; status: 'pending' | 'posted' | 'voided'; createdAt: string; }
export interface RuleSnapshot { version: string; frozenAt: string; ruleIds: string[]; }
export interface RiskSignal { code: string; score: number; explanation: string; participants: string[]; }
export interface AuditEntry { sequence: number; eventId: string; type: ClaimEventType; occurredAt: string; actor: string; summary: string; }

export interface VehicleValuation { id: string; version: number; marketValueMinor: number; currency: string; assessor: string; assessedAt: string; supersedes?: string; }
export interface TotalLossAssessment { id: string; valuationId: string; valuationVersion: number; repairEstimateMinor: number; thresholdRatio: number; thresholdMinor: number; marketValueMinor: number; ruleVersion?: string; isTotalLoss: boolean; decidedAt: string; basisHash: string; supersedesAssessmentId?: string; }
export interface SalvageDisposal { taskId: string; assessmentId: string; status: 'collecting' | 'selected' | 'completed' | 'failed'; createdAt: string; }
export interface SalvageBid { id: string; bidder: string; amountMinor: number; currency: string; valuationVersion: number; receivedAt: string; validUntil: string; status: 'open' | 'selected' | 'withdrawn' | 'expired' | 'lost'; expiredReason?: string; }
export interface SalvageDeal { id: string; bidId: string; amountMinor: number; currency: string; completedAt: string; callbackKey: string; status: 'completed' | 'reversed'; reversedAt?: string; reversalReason?: string; }
export interface OwnershipRecord { status: 'pending' | 'transferred_to_insurer' | 'retained_by_owner'; decidedAt?: string; causedBy?: string; }

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
  valuations: VehicleValuation[];
  assessments: TotalLossAssessment[];
  currentAssessmentId?: string;
  disposal?: SalvageDisposal;
  bids: SalvageBid[];
  selectedBidId?: string;
  deal?: SalvageDeal;
  ownership: OwnershipRecord;
  salvageIncomeMinor: number;
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
