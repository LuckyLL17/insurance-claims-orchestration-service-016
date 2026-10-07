import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';

const future = (ms: number) => new Date(Date.now() + ms).toISOString();

function totalLossClaim(app: ReturnType<typeof buildApp>, gross = 60000) {
  return app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'vehicle', id: `car-${Math.random()}` }], loss: { currency: 'CNY', gross } }, 'test');
}

test('evaluates total loss against a frozen valuation basis and starts disposal', () => {
  const app = buildApp();
  const claim = totalLossClaim(app);
  app.totalLoss.recordValuation(claim.id, { marketValue: 80000, assessor: 'appraiser-1' }, 'test');
  const evaluated = app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  const assessment = evaluated.assessments.at(-1)!;
  assert.equal(assessment.isTotalLoss, true);
  assert.equal(assessment.thresholdMinor, 5_600_000);
  assert.equal(assessment.marketValueMinor, 8_000_000);
  assert.equal(assessment.repairEstimateMinor, 6_000_000);
  assert.ok(assessment.basisHash);
  assert.equal(evaluated.status, 'salvage_disposal');
  assert.equal(evaluated.disposal?.status, 'collecting');
  assert.equal(evaluated.disposal?.assessmentId, assessment.id);
  // a newer valuation version must not rewrite the frozen basis
  app.totalLoss.recordValuation(claim.id, { marketValue: 90000, assessor: 'appraiser-2' }, 'test');
  const after = app.claims.get(claim.id);
  assert.equal(after.valuations.length, 2);
  assert.equal(after.valuations.at(-1)!.supersedes, after.valuations[0].id);
  const frozen = after.assessments.find((a) => a.id === assessment.id)!;
  assert.equal(frozen.marketValueMinor, 8_000_000);
  assert.equal(frozen.thresholdMinor, 5_600_000);
});

test('stays off the total loss track below the repair threshold', () => {
  const app = buildApp();
  const claim = totalLossClaim(app, 30000);
  assert.throws(() => app.totalLoss.evaluate(claim.id, {}, 'adjuster'), /valuation required/);
  app.totalLoss.recordValuation(claim.id, { marketValue: 80000, assessor: 'appraiser' }, 'test');
  const evaluated = app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  assert.equal(evaluated.assessments.at(-1)!.isTotalLoss, false);
  assert.equal(evaluated.disposal, undefined);
  assert.throws(() => app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-a', amount: 5000, validUntil: future(3_600_000) }, 'recycler'), /collecting bids/);
});

test('completes the salvage lifecycle, links income to the ledger and ignores duplicate callbacks', () => {
  const app = buildApp();
  const claim = totalLossClaim(app);
  app.totalLoss.recordValuation(claim.id, { marketValue: 80000, assessor: 'appraiser' }, 'test');
  app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  const bidA = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-a', amount: 12000, validUntil: future(3_600_000) }, 'recycler').bids.at(-1)!;
  const bidB = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-b', amount: 15000, validUntil: future(3_600_000) }, 'recycler').bids.at(-1)!;
  app.totalLoss.selectBid(claim.id, bidB.id, 'adjuster');
  const completed = app.totalLoss.completeDeal(claim.id, { bidId: bidB.id, callbackKey: 'callback-1' }, 'recycler');
  assert.equal(completed.deal?.status, 'completed');
  assert.equal(completed.deal?.amountMinor, 1_500_000);
  assert.equal(completed.ownership.status, 'transferred_to_insurer');
  assert.equal(completed.salvageIncomeMinor, 1_500_000);
  assert.equal(completed.approvedMinor, 8_000_000 - 50_000);
  assert.equal(completed.bids.find((b) => b.id === bidA.id)!.status, 'lost');
  const income = completed.payments.find((p) => p.sourceId === `salvage:${completed.deal!.id}`)!;
  assert.equal(income.kind, 'recovery');
  assert.equal(income.amount.minor, -1_500_000);
  // duplicate callback with a different amount must not change the conclusion
  const duplicate = app.totalLoss.completeDeal(claim.id, { bidId: bidB.id, amount: 99999, callbackKey: 'callback-1' }, 'recycler');
  assert.equal(duplicate.deal?.amountMinor, 1_500_000);
  assert.equal(duplicate.approvedMinor, completed.approvedMinor);
  assert.equal(duplicate.version, completed.version);
  assert.equal(duplicate.payments.filter((p) => p.sourceId.startsWith('salvage:')).length, 1);
  // a conflicting callback for the same bid under a new key is rejected
  assert.throws(() => app.totalLoss.completeDeal(claim.id, { bidId: bidB.id, callbackKey: 'callback-2' }, 'recycler'), /already completed/);
  // salvage income stays linked to the payment ledger
  const paid = app.payments.settle(claim.id, { amount: 79500, currency: 'CNY', sourceId: 'payout-1' }, 'pay');
  assert.equal(paid.status, 'partially_paid');
  const balance = paid.payments.filter((p) => p.status === 'posted').reduce((sum, p) => sum + p.amount.minor, 0);
  assert.equal(balance, 7_950_000 - 1_500_000);
});

test('expires stale bids when the valuation is superseded so old quotes cannot change the conclusion', () => {
  const app = buildApp();
  const claim = totalLossClaim(app);
  app.totalLoss.recordValuation(claim.id, { marketValue: 80000, assessor: 'appraiser' }, 'test');
  app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  const stale = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-a', amount: 20000, validUntil: future(3_600_000) }, 'recycler').bids.at(-1)!;
  const revalued = app.totalLoss.recordValuation(claim.id, { marketValue: 75000, assessor: 'appraiser-2' }, 'test');
  const expired = revalued.bids.find((b) => b.id === stale.id)!;
  assert.equal(expired.status, 'expired');
  assert.equal(expired.expiredReason, 'valuation_superseded');
  assert.throws(() => app.totalLoss.selectBid(claim.id, stale.id, 'adjuster'), /cannot be selected/);
  const fresh = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-b', amount: 18000, validUntil: future(3_600_000) }, 'recycler').bids.at(-1)!;
  assert.equal(fresh.valuationVersion, 2);
  app.totalLoss.selectBid(claim.id, fresh.id, 'adjuster');
  const completed = app.totalLoss.completeDeal(claim.id, { bidId: fresh.id, callbackKey: 'cb-fresh' }, 'recycler');
  assert.equal(completed.approvedMinor, 7_500_000 - 50_000);
  assert.equal(completed.salvageIncomeMinor, 1_800_000);
});

test('supports withdrawal, expiry and failed disposal with owner-retained salvage deduction', () => {
  const app = buildApp();
  const claim = totalLossClaim(app);
  app.totalLoss.recordValuation(claim.id, { marketValue: 80000, assessor: 'appraiser' }, 'test');
  app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  const bidA = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-a', amount: 12000, validUntil: future(3_600_000) }, 'recycler').bids.at(-1)!;
  const bidB = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-b', amount: 15000, validUntil: future(60_000) }, 'recycler').bids.at(-1)!;
  const withdrawn = app.totalLoss.withdrawBid(claim.id, bidA.id, 'recycler');
  assert.equal(withdrawn.bids.find((b) => b.id === bidA.id)!.status, 'withdrawn');
  assert.throws(() => app.totalLoss.selectBid(claim.id, bidA.id, 'adjuster'), /cannot be selected/);
  const expired = app.totalLoss.expireBids(claim.id, future(3_600_000), 'system');
  assert.equal(expired.bids.find((b) => b.id === bidB.id)!.status, 'expired');
  const failed = app.totalLoss.failDisposal(claim.id, { reason: 'no valid bids before deadline' }, 'adjuster');
  assert.equal(failed.disposal?.status, 'failed');
  assert.equal(failed.ownership.status, 'retained_by_owner');
  assert.equal(failed.status, 'ready_for_adjustment');
  // best standing bid (15000) becomes the salvage deduction: 80000 - 500 - 15000
  assert.equal(failed.approvedMinor, 6_450_000);
  // a later re-evaluation still over threshold restarts disposal with a clean bid round
  const restarted = app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  assert.equal(restarted.disposal?.status, 'collecting');
  assert.equal(restarted.bids.length, 0);
});

test('reverses a completed deal, voids the income and reopens bidding', () => {
  const app = buildApp();
  const claim = totalLossClaim(app);
  app.totalLoss.recordValuation(claim.id, { marketValue: 80000, assessor: 'appraiser' }, 'test');
  app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  const bid = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-a', amount: 15000, validUntil: future(3_600_000) }, 'recycler').bids.at(-1)!;
  app.totalLoss.selectBid(claim.id, bid.id, 'adjuster');
  const completed = app.totalLoss.completeDeal(claim.id, { bidId: bid.id, callbackKey: 'cb-1' }, 'recycler');
  const dealId = completed.deal!.id;
  const reversed = app.totalLoss.reverseDeal(claim.id, { reason: 'buyer defaulted' }, 'adjuster');
  assert.equal(reversed.deal?.status, 'reversed');
  assert.equal(reversed.deal?.reversalReason, 'buyer defaulted');
  assert.equal(reversed.disposal?.status, 'collecting');
  assert.equal(reversed.ownership.status, 'pending');
  assert.equal(reversed.salvageIncomeMinor, 0);
  assert.equal(reversed.payments.find((p) => p.sourceId === `salvage:${dealId}`)!.status, 'voided');
  assert.equal(reversed.bids.find((b) => b.id === bid.id)!.status, 'open');
  // the original callback cannot re-complete the reversed deal
  const noop = app.totalLoss.completeDeal(claim.id, { bidId: bid.id, callbackKey: 'cb-1' }, 'recycler');
  assert.equal(noop.deal?.status, 'reversed');
  // a fresh selection and callback completes a new deal
  app.totalLoss.selectBid(claim.id, bid.id, 'adjuster');
  const recompleted = app.totalLoss.completeDeal(claim.id, { bidId: bid.id, callbackKey: 'cb-2' }, 'recycler');
  assert.equal(recompleted.deal?.status, 'completed');
  assert.equal(recompleted.salvageIncomeMinor, 1_500_000);
});

test('reopens a claim, reverses the deal and re-evaluates on a new valuation version', () => {
  const app = buildApp();
  const claim = totalLossClaim(app);
  app.totalLoss.recordValuation(claim.id, { marketValue: 80000, assessor: 'appraiser' }, 'test');
  app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  const bid = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-a', amount: 15000, validUntil: future(3_600_000) }, 'recycler').bids.at(-1)!;
  app.totalLoss.selectBid(claim.id, bid.id, 'adjuster');
  const completed = app.totalLoss.completeDeal(claim.id, { bidId: bid.id, callbackKey: 'cb-1' }, 'recycler');
  const firstAssessment = completed.assessments.at(-1)!;
  const reopened = app.claims.addEvent(claim.id, 'claim.reopened', { reason: 'new evidence' }, 'adjuster');
  assert.equal(reopened.status, 'reopened');
  assert.throws(() => app.totalLoss.evaluate(claim.id, {}, 'adjuster'), /reverse it before re-evaluating/);
  app.totalLoss.reverseDeal(claim.id, { reason: 'ownership transfer failed' }, 'adjuster');
  app.totalLoss.recordValuation(claim.id, { marketValue: 70000, assessor: 'appraiser-2' }, 'test');
  const reevaluated = app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  const second = reevaluated.assessments.at(-1)!;
  assert.equal(second.supersedesAssessmentId, firstAssessment.id);
  assert.equal(second.thresholdMinor, 4_900_000);
  assert.equal(second.isTotalLoss, true);
  assert.equal(reevaluated.disposal?.status, 'collecting');
  // the v1 bid was expired by the new valuation; a fresh v2 bid drives a new deal
  assert.equal(reevaluated.bids.find((b) => b.id === bid.id)!.status, 'expired');
  const fresh = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-b', amount: 14000, validUntil: future(3_600_000) }, 'recycler').bids.at(-1)!;
  app.totalLoss.selectBid(claim.id, fresh.id, 'adjuster');
  const recompleted = app.totalLoss.completeDeal(claim.id, { bidId: fresh.id, callbackKey: 'cb-2' }, 'recycler');
  assert.equal(recompleted.approvedMinor, 7_000_000 - 50_000);
});

test('replays to any sequence and exposes the valuation-bid-payout causality chain', () => {
  const app = buildApp();
  const claim = totalLossClaim(app);
  app.totalLoss.recordValuation(claim.id, { marketValue: 80000, assessor: 'appraiser' }, 'test');
  app.totalLoss.evaluate(claim.id, {}, 'adjuster');
  app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-a', amount: 12000, validUntil: future(3_600_000) }, 'recycler');
  const bidB = app.totalLoss.receiveBid(claim.id, { bidder: 'recycler-b', amount: 15000, validUntil: future(3_600_000) }, 'recycler').bids.at(-1)!;
  app.totalLoss.selectBid(claim.id, bidB.id, 'adjuster');
  const full = app.totalLoss.completeDeal(claim.id, { bidId: bidB.id, callbackKey: 'cb-1' }, 'recycler');
  const replayed = app.replay.execute(claim.id);
  assert.equal(replayed.state.version, full.version);
  assert.equal(replayed.state.salvageIncomeMinor, 1_500_000);
  const lineage = app.replay.lineage(claim.id);
  const valuationLink = lineage.links.find((l) => l.type === 'vehicle.valuation.recorded')!;
  const assessmentLink = lineage.links.find((l) => l.type === 'total_loss.evaluated')!;
  assert.equal(assessmentLink.causality.valuationId, valuationLink.causality.valuationId);
  const dealLink = lineage.links.find((l) => l.type === 'salvage.deal.completed')!;
  const incomeLink = lineage.links.find((l) => l.type === 'salvage.income.posted')!;
  assert.equal(dealLink.causality.bidId, bidB.id);
  assert.equal(incomeLink.causality.dealId, dealLink.causality.dealId);
  const ownershipLink = lineage.links.filter((l) => l.type === 'vehicle.ownership.updated').at(-1)!;
  assert.equal(ownershipLink.causality.ownership, 'transferred_to_insurer');
  assert.equal(ownershipLink.causality.causedByEventId, dealLink.eventId);
  const adjustLink = lineage.links.filter((l) => l.type === 'adjustment.approved').at(-1)!;
  assert.equal(adjustLink.causality.causedByEventId, dealLink.eventId);
  // replaying to just before the deal shows the selected bid with no payout conclusion
  const before = app.replay.execute(claim.id, dealLink.sequence - 1);
  assert.equal(before.state.deal, undefined);
  assert.equal(before.state.disposal?.status, 'selected');
  assert.equal(before.state.salvageIncomeMinor, 0);
});
