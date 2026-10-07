import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';

function vehicleClaim() {
  const app = buildApp();
  const claim = app.claims.create({
    policyId: 'P-100',
    lossAt: '2026-08-01T08:00:00Z',
    reportedAt: '2026-08-01T09:00:00Z',
    channel: 'mobile',
    participants: [{ kind: 'vehicle', id: 'car-1' }, { kind: 'person', id: 'owner-1' }],
    loss: { currency: 'CNY', gross: 80_000 }
  }, 'test');
  return { app, claim };
}

function totalLossAt(app: ReturnType<typeof buildApp>, claimId: string, repair = 80_000, value = 100_000) {
  app.totalLoss.recordRepairEstimate(claimId, { vehicleId: 'car-1', amount: repair, source: 'shop', at: '2026-08-02T08:00:00Z' }, 'adjuster');
  app.totalLoss.recordVehicleValuation(claimId, { vehicleId: 'car-1', amount: value, source: 'market-guide', at: '2026-08-02T08:00:00Z' }, 'adjuster');
  return app.totalLoss.assess(claimId, { vehicleId: 'car-1', repairThresholdRatio: 0.7, at: '2026-08-02T09:00:00Z' }, 'adjuster');
}

test('freezes total loss basis, handles expired quotes and failed disposal, then links sale, recovery, ownership and approval', () => {
  const { app, claim } = vehicleClaim();
  let state = totalLossAt(app, claim.id);
  assert.equal(state.status, 'salvage_disposal');
  assert.equal(state.totalLossBases[0].candidate, true);
  const firstDisposition = state.salvageDispositions[0];
  assert.equal(firstDisposition.status, 'open');
  assert.equal(app.tasks.list(claim.id).some((task) => task.kind === 'salvage_disposal'), true);

  state = app.totalLoss.receiveQuote(claim.id, { bidderId: 'recycler-a', amount: 20_000, validUntil: '2026-08-10T00:00:00Z', at: '2026-08-03T00:00:00Z' }, 'recycler');
  const expiredQuote = state.salvageQuotes[0];
  state = app.totalLoss.expireQuotes(claim.id, firstDisposition.id, { at: '2026-08-11T00:00:00Z' }, 'scheduler');
  assert.equal(state.salvageQuotes[0].status, 'expired');
  assert.throws(() => app.totalLoss.selectQuote(claim.id, expiredQuote.id, { at: '2026-08-11T00:01:00Z' }, 'adjuster'), /expired/);
  state = app.totalLoss.failDisposition(claim.id, firstDisposition.id, { at: '2026-08-11T01:00:00Z', reason: 'no live bid' }, 'adjuster');
  assert.equal(state.status, 'salvage_failed');
  assert.equal(firstDisposition.id, state.salvageDispositions[0].id);

  state = app.totalLoss.createDisposition(claim.id, { vehicleId: 'car-1', at: '2026-08-11T02:00:00Z' }, 'adjuster');
  state = app.totalLoss.receiveQuote(claim.id, { bidderId: 'recycler-b', amount: 25_000, validUntil: '2026-08-20T00:00:00Z', at: '2026-08-12T00:00:00Z' }, 'recycler');
  const winningQuote = state.salvageQuotes.find((quote) => quote.bidderId === 'recycler-b')!;
  state = app.totalLoss.selectQuote(claim.id, winningQuote.id, { at: '2026-08-12T01:00:00Z' }, 'adjuster');
  assert.equal(state.salvageDispositions.at(-1)?.selectedQuoteId, winningQuote.id);

  state = app.totalLoss.confirmSale(claim.id, { callbackId: 'sale-cb-1', quoteId: winningQuote.id, amountMinor: 2_500_000, fromOwner: 'owner-1', at: '2026-08-13T00:00:00Z' }, 'auction');
  assert.equal(state.status, 'salvage_sold');
  assert.equal(state.approvedMinor, 5_500_000);
  assert.equal(state.payments.find((payment) => payment.kind === 'recovery')?.amount.minor, -2_500_000);
  assert.equal(state.vehicleOwnership?.status, 'transferred');
  assert.equal(state.vehicleOwnership?.currentOwner, 'recycler-b');
  assert.equal(state.adjustments.at(-1)?.salvageQuoteId, winningQuote.id);

  state = app.totalLoss.confirmSale(claim.id, { callbackId: 'sale-cb-1', quoteId: winningQuote.id, amountMinor: 2_500_000, at: '2026-08-13T00:00:00Z' }, 'auction');
  assert.equal(state.payments.length, 1);

  const replay = app.replay.execute(claim.id);
  assert.equal(replay.state.approvedMinor, 5_500_000);
  assert.equal(replay.state.vehicleOwnership?.currentOwner, 'recycler-b');

  state = app.payments.settle(claim.id, { amount: 55_000, currency: 'CNY', sourceId: 'claimant-pay-1' }, 'payment');
  assert.equal(state.status, 'settled');
  assert.equal(state.payments.filter((payment) => payment.kind === 'settlement').length, 1);

  const causality = app.totalLoss.causality(claim.id);
  assert.ok(causality.links.some((link) => link.relation === 'offsets_approval'));
});

test('valuation and assessment versions supersede old disposition so stale quotes cannot change the current payout', () => {
  const { app, claim } = vehicleClaim();
  let state = totalLossAt(app, claim.id);
  const oldDisposition = state.salvageDispositions[0];
  state = app.totalLoss.receiveQuote(claim.id, { bidderId: 'stale-recycler', amount: 20_000, validUntil: '2026-09-01T00:00:00Z', at: '2026-08-03T00:00:00Z' }, 'recycler');
  const staleQuote = state.salvageQuotes[0];

  app.totalLoss.recordVehicleValuation(claim.id, { vehicleId: 'car-1', amount: 90_000, source: 'market-guide-v2', at: '2026-08-04T08:00:00Z' }, 'adjuster');
  state = app.totalLoss.assess(claim.id, { vehicleId: 'car-1', repairThresholdRatio: 0.7, at: '2026-08-04T09:00:00Z' }, 'adjuster');
  assert.equal(state.vehicleValuations.filter((item) => item.status === 'current').length, 1);
  assert.equal(state.totalLossBases[0].status, 'superseded');
  assert.equal(state.totalLossBases[1].valuationVersion, 2);
  assert.equal(state.salvageDispositions[0].status, 'superseded');
  assert.equal(state.salvageQuotes[0].status, 'superseded');
  assert.throws(() => app.totalLoss.selectQuote(claim.id, staleQuote.id, { at: '2026-08-04T10:00:00Z' }, 'adjuster'), /superseded|cannot|does not match|active/);

  state = app.totalLoss.receiveQuote(claim.id, { bidderId: 'current-recycler', amount: 15_000, validUntil: '2026-09-01T00:00:00Z', at: '2026-08-05T00:00:00Z' }, 'recycler');
  const currentQuote = state.salvageQuotes.find((quote) => quote.status === 'submitted')!;
  assert.notEqual(currentQuote.id, staleQuote.id);
  assert.equal(currentQuote.basisVersion, 2);
  assert.equal(oldDisposition.id, state.salvageDispositions[0].id);
});

test('withdrawn quote cannot be selected and a non-total-loss assessment freezes a repairable decision', () => {
  const { app, claim } = vehicleClaim();
  let state = totalLossAt(app, claim.id, 50_000, 100_000);
  assert.equal(state.status, 'ready_for_adjustment');
  assert.equal(state.totalLossBases[0].candidate, false);
  assert.equal(state.salvageDispositions.length, 0);

  app.totalLoss.recordRepairEstimate(claim.id, { vehicleId: 'car-1', amount: 85_000, source: 'shop-v2', at: '2026-08-03T08:00:00Z' }, 'adjuster');
  state = app.totalLoss.assess(claim.id, { vehicleId: 'car-1', repairThresholdRatio: 0.7, at: '2026-08-03T09:00:00Z' }, 'adjuster');
  state = app.totalLoss.receiveQuote(claim.id, { bidderId: 'recycler-x', amount: 18_000, validUntil: '2026-08-20T00:00:00Z', at: '2026-08-04T00:00:00Z' }, 'recycler');
  const quote = state.salvageQuotes[0];
  state = app.totalLoss.withdrawQuote(claim.id, quote.id, { at: '2026-08-04T01:00:00Z', reason: 'bidder error' }, 'recycler');
  assert.equal(state.salvageQuotes[0].status, 'withdrawn');
  assert.throws(() => app.totalLoss.selectQuote(claim.id, quote.id, { at: '2026-08-04T02:00:00Z' }, 'adjuster'), /withdrawn|cannot/);
});

test('post-sale cancellation revokes ownership, reverses recovery, restores gross approval and allows duplicate cancellation callbacks', () => {
  const { app, claim } = vehicleClaim();
  let state = totalLossAt(app, claim.id);
  state = app.totalLoss.receiveQuote(claim.id, { bidderId: 'recycler-c', amount: 25_000, validUntil: '2026-08-20T00:00:00Z', at: '2026-08-03T00:00:00Z' }, 'recycler');
  const quote = state.salvageQuotes[0];
  app.totalLoss.selectQuote(claim.id, quote.id, { at: '2026-08-03T01:00:00Z' }, 'adjuster');
  state = app.totalLoss.confirmSale(claim.id, { callbackId: 'sale-ok', quoteId: quote.id, amountMinor: 2_500_000, fromOwner: 'owner-1', at: '2026-08-04T00:00:00Z' }, 'auction');
  assert.equal(state.approvedMinor, 5_500_000);

  state = app.totalLoss.cancelSale(claim.id, { callbackId: 'sale-cancel', quoteId: quote.id, reason: 'buyer default', at: '2026-08-05T00:00:00Z' }, 'auction');
  assert.equal(state.status, 'salvage_disposal');
  assert.equal(state.approvedMinor, 8_000_000);
  assert.equal(state.vehicleOwnership?.status, 'revoked');
  assert.equal(state.vehicleOwnership?.currentOwner, 'owner-1');
  assert.deepEqual(state.payments.map((payment) => payment.kind), ['recovery', 'recovery_reversal']);
  assert.equal(state.adjustments.at(-1)?.salvageProceedsMinor, 0);

  const eventCount = app.replay.execute(claim.id).events.length;
  state = app.totalLoss.cancelSale(claim.id, { callbackId: 'sale-cancel', quoteId: quote.id, reason: 'buyer default', at: '2026-08-05T00:00:00Z' }, 'auction');
  assert.equal(app.replay.execute(claim.id).events.length, eventCount);
  assert.equal(state.payments.length, 2);
});

test('reopened sold claim can accept a new valuation basis while the historical sale remains causally linked', () => {
  const { app, claim } = vehicleClaim();
  let state = totalLossAt(app, claim.id);
  state = app.totalLoss.receiveQuote(claim.id, { bidderId: 'recycler-r', amount: 25_000, validUntil: '2026-08-20T00:00:00Z', at: '2026-08-03T00:00:00Z' }, 'recycler');
  const quote = state.salvageQuotes[0];
  app.totalLoss.selectQuote(claim.id, quote.id, { at: '2026-08-03T01:00:00Z' }, 'adjuster');
  app.totalLoss.confirmSale(claim.id, { callbackId: 'sold-before-reopen', quoteId: quote.id, amountMinor: 2_500_000, fromOwner: 'owner-1', at: '2026-08-04T00:00:00Z' }, 'auction');
  assert.throws(() => totalLossAt(app, claim.id, 80_000, 85_000), /reopened/);

  state = app.totalLoss.reopen(claim.id, { reason: 'new valuation evidence', at: '2026-08-06T00:00:00Z' }, 'supervisor');
  assert.equal(state.status, 'reopened');
  app.totalLoss.recordVehicleValuation(claim.id, { vehicleId: 'car-1', amount: 85_000, source: 'market-guide-v2', at: '2026-08-06T01:00:00Z' }, 'supervisor');
  state = app.totalLoss.assess(claim.id, { vehicleId: 'car-1', repairThresholdRatio: 0.7, at: '2026-08-06T02:00:00Z' }, 'supervisor');
  assert.equal(state.totalLossBases[0].status, 'superseded');
  assert.equal(state.audit.some((entry) => entry.type === 'claim.reopened'), true);
  assert.equal(state.totalLossBases[1].status, 'frozen');
  assert.equal(state.salvageDispositions[0].status, 'sold');
  assert.equal(state.salvageDispositions.at(-1)?.status, 'open');
  assert.equal(app.totalLoss.causality(claim.id).links.some((link) => link.relation === 'reopens'), true);
});
