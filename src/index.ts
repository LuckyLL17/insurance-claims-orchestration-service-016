import { EventStore } from './application/event-store';
import { ClaimService } from './application/claim-service';
import { PaymentService } from './application/payment-service';
import { RiskService } from './application/risk-service';
import { TaskService } from './application/task-service';
import { ReplayService } from './application/replay-service';
import { TotalLossService } from './application/total-loss-service';
import { EvidenceLedger } from './domain/evidence';
import { PaymentLedger } from './domain/payment-ledger';
import { PolicyCatalog } from './domain/policy';
import { RiskGraph } from './domain/risk';
import { RuleEngine } from './domain/rules';
import { TaskBoard } from './domain/task';
import { TotalLossPolicy } from './domain/total-loss';
import { startServer } from './http/server';

export function buildApp() {
  const events = new EventStore();
  const policies = new PolicyCatalog();
  const rules = new RuleEngine();
  const claims = new ClaimService(events, policies, rules, new EvidenceLedger());
  const ledger = new PaymentLedger();
  const tasks = new TaskBoard();
  const totalLoss = new TotalLossService(events, claims, tasks, ledger, new TotalLossPolicy());
  return {
    claims,
    payments: new PaymentService(claims, ledger),
    risks: new RiskService(claims, new RiskGraph()),
    tasks: new TaskService(claims, tasks),
    totalLoss,
    replay: new ReplayService(events, claims),
    rules
  };
}

if (require.main === module) void startServer(buildApp());
