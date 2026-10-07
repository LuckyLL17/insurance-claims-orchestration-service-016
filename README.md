# 保险理赔案件编排与反欺诈调查服务

一个可本地运行的 Node.js + TypeScript 纯后端项目。系统不依赖 Docker、数据库或第三方服务，使用内存事件存储模拟真实的理赔领域基础设施，适合继续扩展 0-1、Feature、Bug 和综合题。

## 核心能力

- 保单版本与事故发生时间的责任快照
- 报案、补件、查勘、核验、理算、支付、结案状态机
- 事件溯源、幂等事件接收、乱序事件重放
- 可冻结、发布和回滚的规则版本
- 证据版本链、哈希、引用快照和审计轨迹
- 分阶段支付、追回、冲正和赔付上限账本
- 设备、车辆、人员、维修厂、账户的风险关联图
- 调查任务租约、过期提交保护和重派
- 单案件及跨案件风险解释
- 车辆全损评估：估损、维修阈值与市场估值的冻结依据和估值版本链
- 残值处置：多回收报价的接收、选择、撤回、过期、流标、成交回调与成交后撤销
- 残值收入、车辆所有权与支付账本联动，估值-报价-赔付全链路因果查询

## 全损与残值处置 API

- `POST /claims/:id/valuations` 记录车辆市场估值（新版本自动作废旧版本上的未决报价）
- `POST /claims/:id/total-loss/evaluate` 按估损与维修阈值评估全损并冻结评估依据
- `GET /claims/:id/total-loss` 查询当前评估、历史评估与估值版本链
- `POST /claims/:id/salvage/bids` 接收回收报价；`POST .../bids/:bidId/select|withdraw` 选择或撤回
- `POST /claims/:id/salvage/expire` 按时间点作废过期报价；`POST .../salvage/fail` 流标
- `POST /claims/:id/salvage/deal` 成交回调（按 `callbackKey` 幂等）；`POST .../deal/reverse` 成交后撤销
- `GET /claims/:id/salvage` 查询处置任务、报价、成交、所有权与残值收入
- `GET /claims/:id/lineage` 查询估值、报价与赔付变化的因果关系链

## 启动

```bash
npm install
npm run build
npm test
npm start
```

服务默认监听 `http://localhost:4100`，可用 `PORT=4200 npm start` 修改端口。

## 示例

```bash
curl http://localhost:4100/health
curl -X POST http://localhost:4100/claims \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-claim-1' \
  -d '{"policyId":"P-100","lossAt":"2026-10-06T08:00:00Z","reportedAt":"2026-10-06T09:00:00Z","participants":[{"kind":"person","id":"person-1"},{"kind":"vehicle","id":"car-1"}],"loss":{"currency":"CNY","gross":18000},"channel":"mobile"}'
```

## 目录说明

- `src/domain`：理赔领域模型、规则、账本、证据、风险图谱和任务租约
- `src/application`：事件存储、案件编排、支付、风险、任务和重放用例
- `src/infrastructure`：可替换的内存存储实现
- `src/http`：无框架 HTTP 路由和 JSON API
- `src/test`：跨模块行为测试
