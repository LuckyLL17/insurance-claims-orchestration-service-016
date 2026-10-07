# 保险理赔案件编排与反欺诈调查服务

一个可本地运行的 Node.js + TypeScript 纯后端项目。系统不依赖 Docker、数据库或第三方服务，使用内存事件存储模拟真实的理赔领域基础设施，适合继续扩展 0-1、Feature、Bug 和综合题。

## 核心能力

- 保单版本与事故发生时间的责任快照
- 报案、补件、查勘、核验、理算、支付、结案状态机
- 事件溯源、幂等事件接收、乱序事件重放
- 可冻结、发布和回滚的规则版本
- 证据版本链、哈希、引用快照和审计轨迹
- 分阶段支付、追回、冲正和赔付上限账本
- 车辆维修估损版本、市场估值版本和全损阈值评估
- 全损依据冻结、残值处置任务、多家回收商报价、撤回、过期、选择和流标
- 残值成交回调、重复回调幂等、成交后撤销、所有权转移/收回和残值收入入账
- 赔付批准额、残值回收、支付账本、车辆所有权和全损版本的因果关联
- 设备、车辆、人员、维修厂、账户的风险关联图
- 调查任务租约、过期提交保护和重派
- 单案件及跨案件风险解释

## 启动

```bash
npm install
npm run build
npm test
npm start
```

服务默认监听 `http://localhost:4100`，可用 `PORT=4200 npm start` 修改端口。

## 车辆全损与残值处置

链路中的金额在领域状态中使用最小货币单位；HTTP 输入的估损、估值和报价金额仍使用元。

1. `POST /claims/:id/repair-estimates` 写入维修估损版本。
2. `POST /claims/:id/vehicle-valuations` 写入车辆市场估值版本。
3. `POST /claims/:id/total-loss/assess` 用当前估损、当前市场估值和维修阈值冻结全损依据。若达到阈值，自动生成残值处置任务。
4. `POST /claims/:id/salvage/quotes` 接收报价；每个报价携带处置 ID、全损依据版本、估值版本和过期时间。
5. `POST /claims/:id/salvage/quotes/:quoteId/withdraw` 撤回报价。
6. `POST /claims/:id/salvage/quotes/expire` 根据当前时间批量使已过期报价失效。
7. `POST /claims/:id/salvage/quotes/:quoteId/select` 选择仍有效且版本匹配的报价。
8. `POST /claims/:id/salvage/dispositions/:dispositionId/fail` 在没有有效报价时流标；可再次创建处置任务。
9. `POST /claims/:id/salvage/callbacks/sale` 接收成交回调，完成所有权转移、残值收入入账和净赔付批准。
10. `POST /claims/:id/salvage/callbacks/cancel` 处理成交后撤销，收回所有权、冲回残值收入并恢复毛赔付批准额。
11. `POST /claims/:id/reopen` 支持案件重开。
12. `GET /claims/:id/total-loss` 查询当前版本、报价、处置、所有权和账本汇总。
13. `GET /claims/:id/causality` 查询估值、依据、报价、成交、所有权、回收和赔付之间的因果边。
14. `POST /claims/:id/replay` 重放事件；可传 `{ "until": 12 }` 查看历史版本。

旧估损/估值重新评估时会冻结新的全损依据，并将旧处置及旧报价标记为 `superseded`。旧报价不能选择、成交或调整当前批准额。成交后的历史记录默认保留；只有案件重开后才能基于新估值形成新依据。成交和撤销回调均以 `callbackId` 幂等。

## 示例

```bash
curl http://localhost:4100/health
curl -X POST http://localhost:4100/claims \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-claim-1' \
  -d '{"policyId":"P-100","lossAt":"2026-10-06T08:00:00Z","reportedAt":"2026-10-06T09:00:00Z","participants":[{"kind":"person","id":"person-1"},{"kind":"vehicle","id":"car-1"}],"loss":{"currency":"CNY","gross":18000},"channel":"mobile"}'
```

## 目录说明

- `src/domain`：理赔领域模型、规则、账本、证据、风险图谱、全损策略和任务租约
- `src/application`：事件存储、案件编排、支付、风险、任务、全损残值和重放用例
- `src/infrastructure`：可替换的内存存储实现
- `src/http`：无框架 HTTP 路由和 JSON API
- `src/test`：跨模块行为测试
