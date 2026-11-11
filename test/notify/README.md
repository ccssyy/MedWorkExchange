# notify 云函数离线逻辑验证

用 `wx-server-sdk` 桩在本地跑 `cloudfunctions/notify` 的出站判定，**不连云、不写库、不发真实订阅消息**。

## 运行

```bash
cd /Users/samchen/WorkBuddy/Worktrees/MedWorkExchange/develop-8d62b487
NODE_PATH="$PWD/test/stub" \
  /Users/samchen/.workbuddy/binaries/node/versions/22.22.2-2/bin/node test/notify/notify.test.js
```

全绿输出末行为 `PASS 51 / FAIL 0`，失败时退出码为 1。

## 覆盖的 10 组场景

| 组 | 场景 | 断言要点 |
|---|---|---|
| A | 模板全未配置 | 不发任何微信请求；积压 pending 全部置 `skipped/templates_not_configured` |
| B | 鉴权边界 | drain/stats/send 无 testKey 被拒；`templates` 开放且只返回非空 ID |
| C | 正常发送 | 请求载荷逐字段核对：touser/templateId/page/miniprogramState；`thing` 截断至 20 字；`time` 格式化为中文年月日 |
| D | 空值回落 | 空值与**缺失键**均回落为「无」（防止把 `dealingTitle` 之类的键名当正文发出）；`=` 前缀的字面量原样输出 |
| E | 不可重试错误 | 43101 用户拒收 → `skipped`；47003 参数错 / 40003 openid 无效 / 41030 页面不存在 → `failed`；四者 `attempts` 均不递增 |
| F | 可重试错误 | 系统繁忙 → 保持 `pending` 且 `attempts` 累加；达 `maxAttempts` → `failed/retry_exhausted` |
| G | 其他终态 | 未知模板、模板 ID 缺失、超 TTL、接收方不存在各自的定性；混合批次中失败项不中断后续发送 |
| H | scan 只读巡检 | 报告预演结果，但不写库、不发请求 |
| I | 联调单发 | 成功回传 `sentTo`；失败回传 `errCode` 与 `dataSent`（用于核对字段映射） |
| J | stats 观测 | 返回分状态计数与最近问题条目 |

## 桩的可编程失败

`test/stub` 暴露了测试专用的失败注入接口：

```js
sdk.__store.setSendBehavior(() => {
  const e = new Error('mock')
  e.errCode = 43101      // 想验证哪个分支就填哪个错误码
  e.errMsg = 'mock'
  return e               // 返回 Error 即抛出，返回 null 视为成功
})
sdk.__store.sendCalls()  // 取全部已发出的请求载荷做断言
```

## 注意

- 模板 ID 通过直接改写 `cloudfunctions/notify/templates.js` 导出的对象来临时填充（测试与云函数 `require` 到的是同一实例），因此**不需要**为了测试去改生产配置。
- 本测试验证**规则逻辑与字段清洗**，不验证微信侧真实约束（如模板字段名是否匹配实际申请到的模板）。字段映射正确性必须用 `action: 'send'` 对真实账号联调一次确认。
- 时间基准取运行时 `Date.now()`，用例中的时间点均为相对构造，不会随日期失效。
