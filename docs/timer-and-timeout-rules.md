# 超时兜底定时任务（timer 云函数）

| 项 | 值 |
|---|---|
| 对应架构条款 | `docs/architecture-and-product-design.md` §3.2「超时规则（防挂单，云函数定时任务实现）」 |
| 云函数 | `cloudfunctions/timer/` |
| 触发频率 | 每小时整点（`config.json` → `triggers`） |
| 离线验证 | `test/timer/timer.test.js`（28 项断言，SDK 桩驱动，不连云） |
| 状态 | 代码完成、离线验证通过；**待部署并到控制台调整超时时间** |

---

## 一、规则一览

| # | 规则 | 触发条件 | 动作 | 落库字段 |
|---|---|---|---|---|
| 1 | 到期无人接 → 自动关闭 | `status ∈ {published, applied}` 且 `end_time ≤ now` | 拒绝全部 `pending` 申请；单据置 `cancelled` | `status, close_reason='expired_no_accept', closed_at, updated_at` |
| 2a | 履约收尾超时 → 提醒 | `status = in_progress` 且锚点已过 **72h** 且未提醒过 | 打提醒标记（等订阅消息模块消费） | `reminded_at, remind_reason='service_timeout_72h', updated_at` |
| 2b | 履约收尾超时 → 自动确认完成 | `status = in_progress` 且锚点已过 **96h** | 置 `completed`，接单方 `stats.completed +1` | `status, completed_at, complete_requested=false, auto_confirmed=true, updated_at` |
| 3 | confirmed 后长期未开始履约 | **默认关闭**（见第五节决策点） | 到期置 `cancelled` | `status, close_reason='stale_confirmed', closed_at, updated_at` |

### 关键实现决策：锚点不取 `updated_at`

架构原文表述为「履约完成后 72h 未确认」。落到现有状态机上，「履约完成」有两个可能时点：

| 锚点 | 含义 | 取值条件 |
|---|---|---|
| `complete_requested_at` | 接单方已点「申请完成」，等发布方确认 | **优先**：`complete_requested === true` 时取此值 |
| `end_time` | 排班时段已结束，双方均未操作 | 兜底：`end_time` 非空时取此值 |

**不能用 `updated_at` 做锚点**——提醒动作本身会写 `updated_at`，把锚点不断后推，单据将永远等不到 96h 自动确认。这是本实现刻意规避的陷阱，对应代码 `serviceAnchor()`。

### 状态机对照

```
published ──申请──> applied ──确认──> confirmed ──开始履约──> in_progress
    │                  │                    │                    │
    └── 规则1 到期关闭 ──┘                    └─ 规则3（默认关）    ├─ 规则2a 72h 提醒
                                                                  └─ 规则2b 96h 自动完成 → completed
```

**与现有代码的一致性**：规则 1 关闭单据时，同步把 `pending` 申请置 `rejected`，与 `dealing.offShelf` 的行为保持一致，避免申请人无限等待。规则 2b 只在乐观锁确认「确实由本任务完成」时才给接单方 `stats.completed +1`，避免与用户手动确认重复计数。

---

## 二、并发与幂等设计

| 风险 | 对策 |
|---|---|
| 定时任务与用户操作竞态（用户正在点「确认完成」，任务同时自动完成） | 所有写操作走 `where({ _id, status: 期望状态 }).update()` 乐观锁，状态已变则更新 0 条、自动放弃 |
| 重复执行导致信用分/履约数虚增 | 规则 2b 仅在 `stats.updated > 0` 时计数；规则 2a 以 `reminded_at` 存在与否去重 |
| 单次处理超出云函数执行时限 | 分批取数（每批 100 条，单次最多 10 批 = 1000 条），云开发单次 `get` 上限即 100 |
| 客户端越权调用触发批量改状态 | 非只读调用必须来自定时触发器（`event.Type === 'Timer'`）或携带正确 `testKey` |
| 定时任务自身异常静默失败 | 异常写 `audit_logs`（`gate='timer_error'`，含 message/stack 截断）并返回非 `ok` |

---

## 三、部署步骤

1. **上传云函数**
   开发者工具 → 右键 `cloudfunctions/timer` →「上传并部署：云端安装依赖」。
   `config.json` 中的 `triggers` 会随部署一并生效。

2. **调整函数超时时间（重要）**
   云开发控制台 → 云函数 → `timer` → 配置 → 将**执行超时时间上调至 30–60 秒**。
   云函数默认超时较短（约 3 秒），批量处理多条单据时可能不足。

3. **确认触发器已创建**
   云开发控制台 → 云函数 → `timer` → 定时触发器，应看到 `timerHourly`，cron 为 `0 0 * * * * *`（每小时整点，云开发 cron 为 7 位：秒 分 时 日 月 周 年）。

4. **补复合索引**（控制台 → 云数据库 → 索引管理）

   | 集合 | 索引字段 | 服务于 |
   |---|---|---|
   | `dealings` | `status` + `end_time`（升序） | 规则 1、规则 2 |
   | `dealings` | `status` + `complete_requested_at`（升序） | 规则 2 |

   > 规则 2 在 `where` 中用了 `_.or([{complete_requested_at}, {end_time}])`，索引未必被完全命中；Pilot 量级（单院长尾数十单）全表扫描可接受，量级上来后建议拆成两趟独立查询。

5. **首跑巡检（不写库）**
   部署后先跑一次只读巡检确认命中数符合预期，再等整点自动触发。

---

## 四、巡检与联调

### 只读巡检（任意账号可调，不写库）

```js
wx.cloud.callFunction({ name: 'timer', data: { action: 'scan' } })
```

返回示例：

```json
{
  "ok": true, "dryRun": true, "trigger": false,
  "rules": { "remindAfterHours": 72, "autoConfirmAfterHours": 96, "staleConfirmedRuleEnabled": false },
  "summary": { "expiredNoAccept": 0, "reminded72h": 1, "autoConfirmed96h": 0, "staleConfirmed": 0 },
  "sample": { "reminded": ["..."], "autoConfirmed": [] },
  "elapsedMs": 128
}
```

### 真实执行（仅联调用，需 testKey）

```js
wx.cloud.callFunction({ name: 'timer', data: { testKey: 'mwe-test-only' } })
```

`testKey` 沿用项目既有约定：`process.env.TEST_KEY || 'mwe-test-only'`（与 `initdb` 测试辅助 action 同源，非安全边界，仅防误触发）。**提审前建议在云函数环境变量中覆盖 `TEST_KEY` 为强口令，或直接删除该分支。**

### 本地离线验证（推荐，不连云）

```bash
cd <repo>
NODE_PATH="$PWD/test/stub" \
  /Users/samchen/.workbuddy/binaries/node/versions/22.22.2-2/bin/node test/timer/timer.test.js
```

覆盖 5 组场景共 36 项断言：越权防护、只读巡检不写库、规则逐条落库（含通知入队 4 条）、幂等性、触发器放行。详见 `test/timer/README.md`。

---

## 五、决策点（需 owner 拍板）

### 决策一：confirmed 后长期未开始履行的单据怎么处理？

已确认锁定（`confirmed`）但双方都没点「开始履约」，排班时段过去后单据会**永久卡在 confirmed**——架构 §3.2 未覆盖此情形。当前代码以 `STALE_CONFIRMED.enabled = false` **默认关闭**。

| 选项 | 动作 | 影响 |
|---|---|---|
| **1（当前实现）** | 超 `120h` 自动置 `cancelled`，不计完成、不动信用分 | 保守；但双方线下若已履约，会被误关闭且无法互评 |
| **2** | 超 `120h` 自动置 `completed`，计入履约数、开放互评 | 激进；若实际未履约，会造成虚假履约记录与评价 |

> 建议：选项 2 更贴合「默认信任线下已履约」的产品假设，但需要你确认业务上「排班时段过了就视为履约完成」是否成立。改 `cloudfunctions/timer/index.js` 中 `STALE_CONFIRMED` 即可切换。

### 决策二：无排班时段的单据（病例指导类）没有兜底

规则 1 依赖 `end_time` 判断到期，而病例指导类**允许不填起止时间**（`dealing.create` 中仅 `shift` 强制要求），因此这类单据永不到期、不会被自动关闭。

| 选项 | 动作 |
|---|---|
| **1（当前）** | 不处理，依赖发布方主动下架 |
| **2** | 增加「`created_at` 超 N 天且无人申请 → 自动关闭」的兜底规则 |

> 建议：Pilot 期先按选项 1 观察实际挂单率，再决定是否加规则。

### 通知已接线

规则 2a / 2b 在落库成功后**直接向 `notifications` 入队**（分别对应模板 `serviceReminder` / `serviceAutoCompleted`，接收方为撮合双方），由 `notify` 云函数统一出站。详见 `docs/subscription-message-guide.md`。

`reminded_at` 字段仍然保留——它的作用已从「待发通知的标记位」变为**幂等守卫与巡检依据**（判断某单是否已被提醒过）。

入队仅在乐观锁确认「本次写入真的生效」时才发生，因此用户抢先自行处理时不会产生多余通知。

---

## 六、未覆盖范围（诚实声明）

1. **通知的实际触达**依赖订阅消息接入（模板 ID 申请 + 用户授权额度）；模板 ID 未配置时通知会留在队列并被标记 `skipped`，各规则的落库行为不受影响。详见 `docs/subscription-message-guide.md`；
2. **`accept_deadline` 字段仍是死字段**：建单时置 `null`，全项目无任何赋值点（`dealing.create` / `initdb.seedApplication` 均为 null）。本次实现绕开了它，**建议后续要么接入真实受理截止时间，要么从数据模型中移除**，避免继续误导；
3. **跨天排班的边界**：锚点取 `end_time` 的绝对时刻，跨天夜班（如 18:00 → 次日 08:00）语义正确，无需特殊处理；
4. **批量上限**：单次最多处理 1000 条，超出部分留待下一小时，极端情况下延后不超过 1 小时。
