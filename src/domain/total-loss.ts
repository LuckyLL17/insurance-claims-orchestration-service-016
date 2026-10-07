import { ClaimState, ClaimStatus, RepairEstimateVersion, TotalLossBasis, VehicleValuationVersion, SalvageQuote, SalvageDisposition } from './types';
import { asMinor } from './ids';

export interface TotalLossInput {
  vehicleId: string;
  repairAmount: number;
  marketValue: number;
  repairThresholdRatio: number;
  salvageBenchmarkMinor?: number;
}

export class TotalLossPolicy {
  freeze(claim: ClaimState, input: TotalLossInput, basisVersion: number, frozenAt: string): TotalLossBasis {
    if (input.repairThresholdRatio < 0 || input.repairThresholdRatio > 1) throw new Error('repair threshold ratio must be between 0 and 1');
    const repairEstimateMinor = asMinor(input.repairAmount);
    const marketValueMinor = asMinor(input.marketValue);
    if (!input.vehicleId) throw new Error('vehicle id is required');
    if (marketValueMinor <= 0) throw new Error('vehicle market value must be positive');

    const estimate = this.currentRepairEstimate(claim, input.vehicleId);
    const valuation = this.currentValuation(claim, input.vehicleId);
    if (!estimate) throw new Error(`current repair estimate is required for vehicle ${input.vehicleId}`);
    if (!valuation) throw new Error(`current vehicle valuation is required for vehicle ${input.vehicleId}`);
    if (estimate.amountMinor !== repairEstimateMinor || valuation.marketValueMinor !== marketValueMinor) {
      throw new Error('assessment must use the current repair estimate and vehicle valuation');
    }

    const repairThresholdMinor = Math.round(marketValueMinor * input.repairThresholdRatio);
    const candidate = repairEstimateMinor >= repairThresholdMinor;
    const reasons = candidate
      ? [`repair estimate ${repairEstimateMinor} >= threshold ${repairThresholdMinor} (${input.repairThresholdRatio} of market value ${marketValueMinor})`]
      : [`repair estimate ${repairEstimateMinor} < threshold ${repairThresholdMinor}`];
    return {
      basisId: `tl_basis_${claim.id}_${basisVersion}`,
      version: basisVersion,
      vehicleId: input.vehicleId,
      estimateVersion: estimate.version,
      repairEstimateMinor,
      valuationVersion: valuation.version,
      marketValueMinor,
      currency: claim.loss.currency,
      repairThresholdRatio: input.repairThresholdRatio,
      repairThresholdMinor,
      salvageBenchmarkMinor: input.salvageBenchmarkMinor ?? 0,
      candidate,
      reasons,
      formula: `candidate = repairEstimateMinor(${repairEstimateMinor}) >= marketValueMinor(${marketValueMinor}) * repairThresholdRatio(${input.repairThresholdRatio})`,
      frozenAt,
      status: 'frozen'
    };
  }

  grossApprovedMinor(claim: ClaimState, basis: TotalLossBasis): number {
    const deductible = claim.policy?.deductibleMinor ?? 0;
    const limit = claim.policy?.limitMinor ?? Number.MAX_SAFE_INTEGER;
    return Math.max(0, Math.min(basis.marketValueMinor - deductible, limit));
  }

  ensureQuoteUsable(claim: ClaimState, disposition: SalvageDisposition, quote: SalvageQuote, at = new Date().toISOString()): void {
    if (quote.dispositionId !== disposition.id) throw new Error(`quote ${quote.id} does not belong to disposition ${disposition.id}`);
    if (quote.basisVersion !== disposition.basisVersion) throw new Error(`quote basis version ${quote.basisVersion} does not match frozen basis ${disposition.basisVersion}`);
    const basis = this.basisByVersion(claim, disposition.basisVersion);
    if (basis.status !== 'frozen' && claim.status !== 'reopened') throw new Error(`basis version ${basis.version} is not active`);
    if (quote.status !== 'submitted' && quote.status !== 'selected') throw new Error(`quote ${quote.id} is ${quote.status}`);
    if (new Date(quote.validUntil).getTime() <= new Date(at).getTime()) throw new Error(`quote ${quote.id} expired at ${quote.validUntil}`);
  }

  currentRepairEstimate(claim: ClaimState, vehicleId: string): RepairEstimateVersion | undefined {
    return claim.repairEstimates.filter((item) => item.vehicleId === vehicleId && item.status === 'current').at(-1);
  }

  currentValuation(claim: ClaimState, vehicleId: string): VehicleValuationVersion | undefined {
    return claim.vehicleValuations.filter((item) => item.vehicleId === vehicleId && item.status === 'current').at(-1);
  }

  currentBasis(claim: ClaimState, vehicleId?: string): TotalLossBasis | undefined {
    return claim.totalLossBases.filter((basis) => basis.status === 'frozen' && (!vehicleId || basis.vehicleId === vehicleId)).at(-1);
  }

  basisByVersion(claim: ClaimState, version: number): TotalLossBasis {
    const basis = claim.totalLossBases.find((item) => item.version === version);
    if (!basis) throw new Error(`unknown total loss basis version ${version}`);
    return basis;
  }

  dispositionById(claim: ClaimState, dispositionId: string): SalvageDisposition {
    const disposition = claim.salvageDispositions.find((item) => item.id === dispositionId);
    if (!disposition) throw new Error(`unknown salvage disposition ${dispositionId}`);
    return disposition;
  }

  quoteById(claim: ClaimState, quoteId: string): SalvageQuote {
    const quote = claim.salvageQuotes.find((item) => item.id === quoteId);
    if (!quote) throw new Error(`unknown salvage quote ${quoteId}`);
    return quote;
  }

  currentDisposition(claim: ClaimState): SalvageDisposition | undefined {
    const basis = this.currentBasis(claim);
    return claim.salvageDispositions
      .filter((item) => item.basisVersion === basis?.version && !['superseded'].includes(item.status))
      .at(-1);
  }

  statusTransitions(): Array<{ from: ClaimStatus; to: ClaimStatus; event: string; when: string }> {
    const row = (from: ClaimStatus, to: ClaimStatus, event: string, when: string) => ({ from, to, event, when });
    return [
      row('ready_for_adjustment', 'total_loss_candidate', 'total_loss.basis.frozen', 'frozen basis is a total loss candidate'),
      row('ready_for_adjustment', 'ready_for_adjustment', 'total_loss.basis.frozen', 'frozen basis is repairable'),
      row('total_loss_candidate', 'salvage_disposal', 'salvage.disposition.created', 'salvage task is created'),
      row('salvage_disposal', 'salvage_disposal', 'salvage.quote.received|withdrawn|expired|selected', 'quote lifecycle advances'),
      row('salvage_disposal', 'salvage_failed', 'salvage.disposition.failed', 'all valid quotes are exhausted'),
      row('salvage_failed', 'salvage_disposal', 'salvage.disposition.created', 'a new disposal attempt starts'),
      row('salvage_disposal', 'salvage_sold', 'salvage.sale.confirmed', 'auction closes the selected quote'),
      row('salvage_sold', 'salvage_disposal', 'salvage.sale.canceled', 'post-sale cancellation is accepted'),
      row('salvage_sold', 'reopened', 'claim.reopened', 'supervisor reopens with preserved sale history')
    ];
  }
}
