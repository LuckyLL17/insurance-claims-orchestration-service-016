import { ClaimState, SalvageBid, VehicleValuation } from './types';

export const DEFAULT_TOTAL_LOSS_THRESHOLD_RATIO = 0.7;

export function latestValuation(claim: ClaimState): VehicleValuation | undefined {
  return claim.valuations.reduce<VehicleValuation | undefined>((best, valuation) => (!best || valuation.version > best.version ? valuation : best), undefined);
}

export function clampApproved(valueMinor: number, limitMinor?: number): number {
  return Math.max(0, Math.min(valueMinor, limitMinor ?? Number.MAX_SAFE_INTEGER));
}

export function bestStandingBid(bids: SalvageBid[]): SalvageBid | undefined {
  return bids.filter((bid) => bid.status !== 'withdrawn').reduce<SalvageBid | undefined>((top, bid) => (!top || bid.amountMinor > top.amountMinor ? bid : top), undefined);
}
