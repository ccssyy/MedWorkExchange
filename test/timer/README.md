# timer 云函数离线逻辑验证

用最小 `wx-server-sdk` 桩在本地跑 `cloudfunctions/timer` 的规则判定，**不连云、不写库、不需要开发者工具**。

## 运行

```bash
cd /Users/samchen/WorkBuddy/Worktrees/MedWorkExchange/develop-8d62b487
NODE_PATH="$PWD/test/stub" \
  /Users/samchen/.workbuddy/binaries/node/versions/22.22.2-2/bin/node test/timer/timer.test.js
```

全绿输出末行为 `PASS 36 / FAIL 0`，失败时进程退出码为 1（可直接用于 CI 门禁）。

## 原理

`timer/index.js` 里 `require('wx-server-sdk')` 由 `NODE_PATH` 指向 `test/stub/wx-server-sdk`——仓库内没有 `node_modules`，因此桩必定生效，不会被真实依赖遮蔽。该桩由 timer 与 notify 两个测试套件共用。

桩实现了 timer 用到的全部查询能力：等值 `where`、`_.in` / `_.lte` / `_.and` / `_.or`、`skip` / `limit` / `get` / `count` / `update` / `add` / `doc`，以及点号路径（`stats.completed`）与 `_.inc`。另附测试专用的 `__store`（`reset` / `seed` / `all`），真实 SDK 无此成员。

## 覆盖的 5 组场景

| 组 | 场景 | 断言要点 |
|---|---|---|
| 1 | 越权防护 | 无触发器身份且无 `testKey` 的写库请求被拒，且确认未产生任何写库 |
| 2 | 只读巡检 `scan` | 命中数正确（到期 2 / 提醒 1 / 自动完成 1），且未写库、未产生 `audit_logs` 与 `notifications` |
| 3 | 真实执行（`testKey`） | 规则逐条落库；`pending` 申请被拒而 `accepted` 申请不动；接单方 `stats.completed +1`；**通知入队 4 条（提醒 2 + 自动完成 2）且覆盖双方** |
| 4 | 幂等性 | 重复执行不再命中，`stats.completed` 不重复计数，**通知不重复入队** |
| 5 | 触发器路径 | `{ Type: 'Timer' }` 调用被放行，返回值回显规则参数 |

## 注意

- 桩只覆盖 timer/notify 用到的 API，**不是通用 SDK 模拟器**；其他云函数要用需先补桩能力。
- 本测试验证的是**规则逻辑**，不验证云数据库真实行为（如 `_.or` 的索引命中、日期比较的服务端语义）。上线前仍建议先跑一次 `scan` 只读巡检对照真实数据。
- 测试时间基准取运行时的 `Date.now()`，用例中的时间点均以「相对当前 N 小时前/后」构造，因此不会随日期失效。
