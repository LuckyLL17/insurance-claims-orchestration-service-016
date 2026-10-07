import { IncomingMessage, ServerResponse } from 'node:http';
import { ClaimService } from '../application/claim-service';
import { PaymentService } from '../application/payment-service';
import { RiskService } from '../application/risk-service';
import { TaskService } from '../application/task-service';
import { ReplayService } from '../application/replay-service';
import { TotalLossService } from '../application/total-loss-service';
import { RuleEngine } from '../domain/rules';

export interface AppContext {
  claims: ClaimService;
  payments: PaymentService;
  risks: RiskService;
  tasks: TaskService;
  totalLoss: TotalLossService;
  replay: ReplayService;
  rules: RuleEngine;
}
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value, (_k, v) => v instanceof Set ? [...v] : v)); };
const body = async (req: IncomingMessage): Promise<any> => { let data = ''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };
const parts = (url: string) => url.split('?')[0].split('/').filter(Boolean);

export async function route(req: IncomingMessage, res: ServerResponse, app: AppContext): Promise<void> {
  try {
    const method = req.method ?? 'GET'; const path = parts(req.url ?? '/'); const input = method === 'POST' ? await body(req) : {};
    if (method === 'GET' && path[0] === 'health') return json(res, 200, { ok: true, service: 'insurance-claims-orchestration', now: new Date().toISOString() });
    if (method === 'POST' && path[0] === 'claims' && path.length === 1) return json(res, 201, app.claims.create({ ...input, loss: { ...input.loss, gross: Number(input.loss.gross) } }, 'api', req.headers['idempotency-key'] as string));
    if (path[0] !== 'claims' || !path[1]) return json(res, 404, { error: 'route not found' });
    const id = path[1];
    if (method === 'GET' && path.length === 2) return json(res, 200, app.claims.get(id));
    if (method === 'POST' && path[2] === 'evidence' && path[4] === 'review') return json(res, 200, app.claims.reviewEvidence(id, path[3], Boolean(input.accepted), 'api', req.headers['idempotency-key'] as string));
    if (method === 'POST' && path[2] === 'evidence') return json(res, 201, app.claims.addEvidence(id, input, 'api', req.headers['idempotency-key'] as string));
    if (method === 'POST' && path[2] === 'events') return json(res, 200, app.claims.addEvent(id, input.type, input.payload, input.actor ?? 'api', input.idempotencyKey, input.occurredAt));
    if (method === 'POST' && path[2] === 'risk') return json(res, 200, app.risks.assess(id, 'api'));
    if (method === 'GET' && path[2] === 'risk') return json(res, 200, { relatedClaims: app.risks.related(id), state: app.claims.get(id) });
    if (method === 'POST' && path[2] === 'payments') return json(res, 200, app.payments.settle(id, input, 'api'));
    if (method === 'POST' && path[2] === 'reversals') return json(res, 200, app.payments.reverse(id, input, 'api'));
    if (method === 'POST' && path[2] === 'tasks') return json(res, 201, app.tasks.create(id, input.kind));
    if (method === 'GET' && path[2] === 'tasks') return json(res, 200, app.tasks.list(id));
    if (method === 'POST' && path[2] === 'replay') return json(res, 200, app.replay.execute(id, input.until));

    if (method === 'POST' && path[2] === 'repair-estimates') return json(res, 201, app.totalLoss.recordRepairEstimate(id, input, input.actor ?? 'api', req.headers['idempotency-key'] as string));
    if (method === 'POST' && path[2] === 'vehicle-valuations') return json(res, 201, app.totalLoss.recordVehicleValuation(id, input, input.actor ?? 'api', req.headers['idempotency-key'] as string));
    if (method === 'POST' && path[2] === 'total-loss' && path[3] === 'assess') return json(res, 201, app.totalLoss.assess(id, { ...input, repairThresholdRatio: Number(input.repairThresholdRatio) }, input.actor ?? 'api', req.headers['idempotency-key'] as string));
    if (method === 'GET' && path[2] === 'total-loss') return json(res, 200, app.totalLoss.query(id));
    if (method === 'GET' && path[2] === 'causality') return json(res, 200, app.totalLoss.causality(id));
    if (method === 'POST' && path[2] === 'reopen') return json(res, 200, app.totalLoss.reopen(id, input, input.actor ?? 'api'));

    if (path[2] === 'salvage') {
      if (method === 'POST' && path[3] === 'dispositions' && path.length === 4) return json(res, 201, app.totalLoss.createDisposition(id, input, input.actor ?? 'api'));
      if (method === 'POST' && path[3] === 'dispositions' && path[5] === 'fail') return json(res, 200, app.totalLoss.failDisposition(id, path[4], input, input.actor ?? 'api'));
      if (method === 'POST' && path[3] === 'quotes' && path.length === 4) return json(res, 201, app.totalLoss.receiveQuote(id, { ...input, amount: Number(input.amount) }, input.actor ?? 'api', req.headers['idempotency-key'] as string));
      if (method === 'POST' && path[3] === 'quotes' && path[4] === 'expire') return json(res, 200, app.totalLoss.expireQuotes(id, input.dispositionId, input, input.actor ?? 'api'));
      if (method === 'POST' && path[3] === 'quotes' && path[5] === 'withdraw') return json(res, 200, app.totalLoss.withdrawQuote(id, path[4], input, input.actor ?? 'api'));
      if (method === 'POST' && path[3] === 'quotes' && path[5] === 'select') return json(res, 200, app.totalLoss.selectQuote(id, path[4], input, input.actor ?? 'api'));
      if (method === 'POST' && path[3] === 'callbacks' && path[4] === 'sale') return json(res, 200, app.totalLoss.confirmSale(id, { ...input, amountMinor: Number(input.amountMinor) }, input.actor ?? 'api'));
      if (method === 'POST' && path[3] === 'callbacks' && path[4] === 'cancel') return json(res, 200, app.totalLoss.cancelSale(id, input, input.actor ?? 'api'));
    }
    return json(res, 404, { error: 'route not found' });
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'unknown error' }); }
}
