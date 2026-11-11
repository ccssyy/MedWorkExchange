# 订阅消息接入指南

| 项 | 值 |
|---|---|
| 对应架构条款 | `docs/architecture-and-product-design.md` §7.2「通知（订阅消息）」 |
| 云函数 | `cloudfunctions/notify/`（出站）+ 四个业务函数（入队） |
| 客户端 | `miniprogram/utils/subscribe.js` |
| 数据集合 | `notifications`（新增，已加入 `initdb` 集合清单） |
| 离线验证 | `test/notify/notify.test.js`（51 项断言，SDK 桩驱动） |
| 状态 | **代码完成、离线验证通过；模板 ID 待申请填写，未上线** |

---

## 一、结论先行

订阅消息的**工程链路已全部打通**，但从「代码就绪」到「用户真的收到通知」还差两步人工操作：

1. 到微信公众平台申请订阅消息模板，把模板 ID 填进 `cloudfunctions/notify/templates.js`；
2. 上传部署 `notify` 云函数，并用 `action: 'send'` 对真实账号联调一次，确认字段映射正确。

在此之前系统**完全静默降级**：通知照常入队、按规则标记为 `skipped`，不报错、不影响任何业务主流程。

---

## 二、架构：Outbox 模式

没有让四个业务函数各自调用微信接口，而是引入一层队列：

```
application ─┐
message ─────┤  ① 只写入队（失败静默）
report ──────┤        │
timer ───────┘        ▼
                 notifications 集合
                   status=pending
                        │
                        ▼  ② notify 云函数每 5 分钟出站
              cloud.openapi.subscribeMessage.send
                        │
                        ▼  ③ 结果回写
              sent / skipped / failed（含错误码）
```

**为什么这么做：**

| 收益 | 说明 |
|---|---|
| 权限面收窄 | 只有 `notify` 需要声明 `subscribeMessage.send` 云调用权限，其余业务函数保持干净 |
| 业务不被通知拖累 | 用户申请成功不该因为通知发送失败而报错——入队异常被 catch 吞掉，绝不向上抛 |
| 集中可观测 | 失败原因、重试次数、错误码全在一处，`action: 'stats'` 一次看全 |
| 可平滑降级 | 模板没配好时通知标记为 `skipped` 而非失败，接入是渐进的 |

**代价（诚实声明）：** 通知有最长 5 分钟的延迟（等待下次 drain）。对「换班被抢单」这类抢时效的场景，5 分钟是可以接受的——因为真正的决策仍在站内完成。

### `notifications` 集合结构

| 字段 | 说明 |
|---|---|
| `to_uid` | 接收方 `users._id`（**只记 uid，发送时才解析 openid**，避免 openid 快照过期） |
| `template_key` | 见下表：`newApplication` / `applicationResult` / … |
| `page` | 点击通知的跳转页（不带前导斜杠） |
| `payload` | 业务数据快照，字段映射从这里取值 |
| `biz_type` / `biz_id` | 溯源（dealing / conversation / report） |
| `dedup_key` | 去重键，便于排查重复入队 |
| `status` | `pending` / `sent` / `skipped` / `failed` |
| `attempts` | 已重试次数（仅可重试类错误累加） |
| `last_error_code` / `last_error_msg` | 错误码与原因（如 `user_refused`、`trial` 阶段重点看这里） |
| `created_at` / `sent_at` / `updated_at` | 时间戳 |

---

## 三、通知场景与授权时机

**一次订阅 = 一次下发额度，且授权归属「当前用户」。** 所以征集时机必须是「用户自己做某个操作时，顺手为自己后续要收的那类通知授权」。下表是本项目的落地方式：

| # | 模板 key | 触发点（服务端） | 接收方 | 授权征集时机（客户端 tap） |
|---|---|---|---|---|
| 1 | `newApplication` | `application.apply` 成功后 | 发布方 | **发布方**点「发布」时，为自己后续收申请授权 |
| 2 | `applicationResult` | `application.accept`：选中的通知「已通过」；其余候选通知「未通过」 | 申请方 | **申请方**点「申请」时授权 |
| 3 | `newMessage` | `message.sendMessage` 成功后 | 收信方 | **发信方**点「发送」时，为自己后续收回复授权 |
| 4 | `serviceReminder` | `timer` 规则 2a（履约 72h 未确认） | 撮合双方 | 各自在确认/开始履约等操作时（当前复用 1、2 的授权池） |
| 5 | `serviceAutoCompleted` | `timer` 规则 2b（96h 自动确认完成） | 撮合双方 | 同上 |
| 6 | `reportResult` | `report.adminResolve`（成立 / 驳回） | 举报人 | 举报人提交举报时（**待接入 tap，见第六节**） |

> 场景 4、5 的授权池复用说明：微信一次性订阅的额度是**按模板分别计数**的，`serviceReminder` 与 `serviceAutoCompleted` 是独立模板，需要各自授权。目前这两类通知会因额度不足退化为 `skipped/user_refused`，**不报错也不重试**。若要真正送达，需在履约节点（开始履约 / 申请完成）补充这两个模板的授权征集。

---

## 四、接入步骤

### 步骤 1：申请模板（决定方案上限）

#### 1.1 先搞清楚订阅消息的两种类型

| | 一次性订阅 | 长期订阅 |
|---|---|---|
| 授权后能发几条 | **1 条**，用完需重新引导订阅 | 长期多次 |
| 开放范围 | 所有小程序 | **仅政务民生 / 医疗 / 交通 / 金融 / 教育 / 设备等特定二级行业类目**，且需公共服务、公立机构性质 |
| 本项目可用性 | ✅ **唯一可用** | ❌ **个人主体申请不到** |

> 结论：本项目（个人主体 `wx31604a391caca372`）**只能用一次性订阅**。所有通知场景的额度都靠用户在操作时逐次授权积累。

#### 1.2 额度语义（最容易误解的地方）

- **授权归属做操作的用户**：A 点击按钮授权，额度加在 A 头上，服务端之后才能给 A 发。
- **额度按模板分别记账**：授权了 `newApplication` 不等于也能发 `newMessage`，各模板独立计数。
- **可累积、无次数上限**：用户点 N 次订阅，就有 N 条下发额度。
- **有效期**：官方文档表述为「用户自主订阅后，开发者**可不限时间**地下发一条对应的服务消息」。社区流传的「7 天失效」**不是官方说法**，但也确有开发者遇到订阅静默失效。
  > 本项目的队列 TTL 设为 24 小时，**目的与额度是否过期无关**——是产品判断：一条三天前的「有人申请了你的换班」对用户已是噪音，不如不发。若你希望尽可能送达，调大 `templates.js` 的 `ttlHours` 即可。
- 用户可在小程序「右上角三点 → 设置」里关闭订阅消息，此时即使额度存在也发不出（返回 43101）。

**「总是保持以上选择，不再询问」的行为**（常被误解）：

| 用户上次的选择 | 后续调用 `requestSubscribeMessage` 时 |
|---|---|
| 勾选「允许」+ 保持选项 | 不再弹窗，**静默为每个勾选的模板各 +1 次额度** |
| 勾选「取消」+ 保持选项 | 不再弹窗，**所有模板额度都不增加**（等于永久拒收） |

即：勾选保持后仍需**主动调用 API** 才会加额度，不调用就不加。

#### 1.3 后台操作路径

1. **确认服务类目** —— mp.weixin.qq.com → 设置 → 基本设置 → 服务类目。
   模板与类目强绑定，类目不符时压根无法选用；改类目需走资质审核。**这一步决定你能选到哪些模板，务必先做。**
2. **挑选模板** —— 功能 → 订阅消息 → 公共模板库，用关键词搜索（如「通知」「提醒」「状态」）。
   优先用公共模板库，通过率远高于自定义。
3. **抄下两个值** —— 在「我的模板」中点进模板详情：
   - **模板 ID**：32 位字符串，写代码全靠它；
   - **关键词字段名与类型**：如 `thing1` 需求标题 / `time3` 申请时间。**字段名必须一字不差。**
4. **回填配置** —— 见下方步骤 2。

> 自定义模板入口较隐蔽：在公共模板库搜索任意词后翻到最后一页，点「帮助我们完善模板库」。审核周期较长，验证期不建议。
>
> 注意：不同小程序选用**同一个模板**，生成的模板 ID **也不相同**，不能互相复制。

#### 1.4 关键词字段类型与硬性限制

一个模板的关键词数量有限（自定义模板最多 5 个），字段名后缀数字由微信给定。发送时 `data` 的 key 必须与模板字段名完全一致：

| 类型前缀 | 含义 | 微信硬性限制 | 本项目自动清洗 |
|---|---|---|---|
| `thing` | 事物（标题、名称） | ≤20 个字符 | 超长截断 |
| `phrase` | 短语（状态词） | ≤5 个汉字 | 超长截断 |
| `character_string` | 数字字母串（单号） | ≤32 字符，仅字母数字 | 过滤非字母数字 |
| `time` | 时间 | 24 小时制，可带年月日 | 压成「2026年9月11日 10:30」 |
| `date` | 日期 | 年月日 | 压成「2026年9月11日」 |
| `number` | 数字 | 仅数字 | 过滤非数字 |
| `amount` | 金额 | 数字 + 货币单位 | 自动补「元」 |
| `phone_number` | 手机号 | 纯数字 | 截取 11 位 |
| `letter` / `symbol` | 字母 / 符号 | 受限字符集 | 截断 |
| `const` | 常量 | 模板内固定值 | 原样透传 |

清洗逻辑见 `cloudfunctions/notify/index.js` 的 `sanitize()`，按字段名前缀自动匹配，**因此换模板只需改配置、不用改代码**。

#### 1.5 常见下发失败码

| 错误码 | 含义 | 本项目处理 |
|---|---|---|
| `47003` | 参数不合法（字段名写错 / 超长 / 格式不符） | `failed / bad_params`，**不重试**——重试无意义，需改配置 |
| `43101` | 用户未订阅或已拒收 | `skipped / user_refused`，不重试 |
| `40003` | openid 无效 | `failed / invalid_openid`，不重试 |
| `41030` | 跳转 page 不存在 | `failed / page_not_exists`，不重试 |
| 其他（如系统繁忙、频率限制） | 临时性错误 | 保持 `pending`，最多重试 3 次 |

#### 1.6 内容红线（会导致模板被回收）

- ❌ **禁止下发营销、广告类内容**，只能使用模板关键词本身承载信息；
- ❌ 不要在备注/自定义文案里夹带推广；
- ❌ 禁止页面一加载就弹订阅面板，必须由用户点击触发（微信会判定违规）。

---

### 步骤 2：填写配置

编辑 `cloudfunctions/notify/templates.js`，把 ID 与字段映射填进对应场景：

```js
newApplication: {
  id: '你的模板ID',
  page: 'pages/my-list/my-list',
  label: '收到新申请',
  fields: {
    thing1: 'dealingTitle',    // 取 payload.dealingTitle
    thing2: 'applicantName',   // 取 payload.applicantName
    time3: 'applyTime'         // 取 payload.applyTime，自动格式化为中文时间
  }
}
```

**映射规则：**

| 写法 | 含义 |
|---|---|
| `'dealingTitle'` | 取 `payload.dealingTitle`；payload 中缺失则回落为占位符「无」 |
| `'=已通过'` | 以 `=` 开头表示**字面量常量**，直接输出等号后的内容 |

**字段类型自动清洗**（越界会被微信拒绝为 47003，所以必须按类型截断）：

| 字段前缀 | 处理 |
|---|---|
| `thing` | 截断至 20 字 |
| `phrase` | 截断至 5 字（`=已通过` / `=未通过` 刚好 3 字） |
| `character_string` | 仅保留字母数字，截断至 32 字符 |
| `time` / `date` | 格式化为「2026年9月11日 10:30」 |
| `amount` | 补齐「元」 |
| `number` / `phone_number` | 仅保留数字 |

> **未配置 `id` 的场景会静默跳过**——可以只接入其中一两个场景，其余保持留空，互不影响。

### 步骤 3：部署与配置

1. 上传部署 `cloudfunctions/notify`（右键 →「上传并部署：云端安装依赖」）；
2. `config.json` 已声明 `permissions.openapi: ["subscribeMessage.send"]`，无需手工配置权限；
3. 确认定时触发器 `notifyDrain`（每 5 分钟）已在控制台创建；
4. **调整函数超时时间**至 20–30 秒（默认约 3 秒，批量出站可能不足）；
5. 跑一次 `initdb` 以创建 `notifications` 集合（或手动在控制台新建）；
6. 补索引（控制台 → 云数据库 → 索引管理）：

   | 集合 | 索引字段 | 服务于 |
   |---|---|---|
   | `notifications` | `status` + `created_at`（升序） | drain 取待发队列 |
   | `notifications` | `status` + `updated_at`（降序） | stats 看最近问题 |

### 步骤 4：联调确认字段映射

**这一步不能省。** 字段名必须与实际申请到的模板完全一致，只能对真实账号验证：

```js
// 在已登录的小程序里执行（或用开发者工具「云函数测试」）
wx.cloud.callFunction({
  name: 'notify',
  data: {
    action: 'send',
    testKey: 'mwe-test-only',
    templateKey: 'newApplication',
    toUid: '<你自己的 users._id>',
    payload: { dealingTitle: '夜班换班', applicantName: '李医生', applyTime: new Date() }
  }
})
```

- 返回 `ok: true` → 字段映射正确，微信已受理；
- 返回 `errCode: 47003` → 字段名/类型不匹配，返回值里的 `dataSent` 会回显实际发出的 `data`，对照模板详情页修正。

> 注意 `templates.js` 中的 `miniprogramState` 默认 `'formal'`（正式版）。用开发版/体验版联调时改为 `'developer'` / `'trial'`，否则收不到。

---

## 五、客户端授权语义（为什么必须预取模板 ID）

微信有两条硬约束，决定了 `miniprogram/utils/subscribe.js` 的写法：

1. **`wx.requestSubscribeMessage` 必须在用户手势的同步调用栈中发起。** 一旦 `await` 了任何异步逻辑（包括网络请求），手势上下文丢失，会报 `can only be invoked by user TAP gesture`。
   → 因此模板 ID 必须在 `app.onLaunch` **预取并缓存**，tap 时直接读缓存同步调用。这就是 `subscribe.prefetch()` 存在的理由。

2. **一次授权 = 一次下发额度，配额可累积。** 用户每次授权的额度独立计算。
   → 因此「A 发消息时授权 `newMessage`」的语义是：**为 A 自己**后续收回复预留额度。这是正确的——授权永远归属做操作的那个人。

```js
const subscribe = require('../../utils/subscribe')

async onSubmit() {
  // 必须在 await 之前同步发起
  subscribe.request([subscribe.KEYS.NEW_APPLICATION])
  this.setData({ submitting: true })
  await wx.cloud.callFunction({ ... })
}
```

`request()` **永不抛错**，所有失败路径（模板未配置、用户拒绝、接口报错）都静默 resolve，不会打断主流程。

---

## 六、已知限制与风险（诚实声明）

| # | 限制 | 影响 | 应对 |
|---|---|---|---|
| 1 | **模板 ID 尚未申请填写** | 当前所有通知都会 `skipped` | 需人工到公众平台申请（步骤 1） |
| 2 | **个人主体的类目与订阅能力受限（已核实）** | ① 长期订阅仅对政务民生/医疗/交通/金融/教育/设备等二级类目开放，且需公共服务、公立机构性质 → **个人主体申请不到**；② 医疗类服务类目不对个人主体开放 → **医疗类模板选不到** | 只能用一次性订阅 + 当前可选类目下的通用模板。本实现把字段映射完全外置为配置，**无论拿到什么模板都能适配、不改代码**。**需你到后台确认实际可选项**（`deployment` 前必做） |
| 3 | **一次性订阅额度会耗尽** | 用户授权一次只能收一条，额度用尽后通知 `skipped/user_refused` | 这是平台机制，无法绕过。长期订阅需企业主体 + 特定行业资质，验证期不适用 |
| 4 | **场景 4、5 的授权池未单独征集** | 履约提醒类通知大概率发不出 | 需在履约节点补充 `serviceReminder` / `serviceAutoCompleted` 的授权征集（见第三节说明） |
| 5 | **场景 6 的客户端征集点未接** | 举报结果通知无授权额度，会 `skipped` | **刻意未接**：「举报」入口 `detail.js:onReportTap` 本身会拉起原因选择弹窗，叠加订阅授权面板存在 UI 冲突风险，且需真机验证。建议在 `utils/report.js` 的提交确认回调（仍属用户点击栈）中补一次 `subscribe.request([KEYS.REPORT_RESULT])` |
| 6 | **通知延迟最长 5 分钟** | 非实时 | 可把 drain 触发器频率调高；代价是函数调用次数上升 |
| 7 | **`notify.drain` 的调度依赖定时触发器** | 触发器未生效则队列只进不出 | 部署后务必在控制台确认触发器已创建 |

> 第 2 项是最需要你尽早确认的：**如果个人主体确实选不到合适的模板，整个订阅消息方案需要降级为「站内红点 + tabBar 角标」**（后者已实现，见 `message.unreadCount`）。建议先花 10 分钟到后台确认可选模板清单，再决定是否继续投入。

---

## 七、验证方法

### 离线验证（不连云，推荐先跑）

```bash
cd /Users/samchen/WorkBuddy/Worktrees/MedWorkExchange/develop-8d62b487
NODE_PATH="$PWD/test/stub" \
  /Users/samchen/.workbuddy/binaries/node/versions/22.22.2-2/bin/node test/notify/notify.test.js
```

覆盖 10 组场景共 51 项断言，详见 `test/notify/README.md`。

### 线上观测

```js
// 只看队列状态，不发消息（需 testKey）
wx.cloud.callFunction({ name: 'notify', data: { action: 'stats', testKey: 'mwe-test-only' } })
```

返回各状态计数与最近 10 条问题记录。另外只读巡检 `action: 'scan'` **无需 testKey**，可随时确认「下一轮会发出几条」。

### 安全提示

`testKey` 沿用项目既有约定：`process.env.TEST_KEY || 'mwe-test-only'`。**提审前建议在云函数环境变量中覆盖为强口令，或删除 `send` / `stats` 分支。**

---

## 八、与验收用例的对应

| 架构 §9 验收用例 | 覆盖方式 |
|---|---|
| C1 「订阅消息触达（申请/确认/提醒）」 | 填好模板 ID 后按第四节步骤 4 联调；`stats` 中对应记录应为 `sent` |
| C2 「违禁内容拦截」 | 与本次改动无关（内容安全管线已在 `msgSecCheck` 层） |

---

## 九、本次改动清单

| 文件 | 改动 |
|---|---|
| `cloudfunctions/notify/index.js` | 新增：出站队列消费（drain / send / stats / templates） |
| `cloudfunctions/notify/templates.js` | 新增：模板配置单一真源 |
| `cloudfunctions/notify/config.json` | 新增：`subscribeMessage.send` 权限 + 每 5 分钟触发器 |
| `cloudfunctions/application/index.js` | 入队：收到新申请、申请结果（通过 / 未通过）；替换 2 处 `TODO(M3)` |
| `cloudfunctions/message/index.js` | 入队：新私信；替换 1 处 `TODO(M3)` |
| `cloudfunctions/report/index.js` | 入队：举报处理结果 |
| `cloudfunctions/timer/index.js` | 入队：履约提醒、系统自动确认完成 |
| `cloudfunctions/initdb/index.js` | 集合清单补 `notifications` |
| `miniprogram/utils/subscribe.js` | 新增：模板预取 + 手势时机征集 + 失败静默 |
| `miniprogram/app.js` | 启动预取模板 ID |
| `miniprogram/pages/publish/publish.js` | 发布时征集 `newApplication` |
| `miniprogram/pages/detail/detail.js` | 申请时征集 `applicationResult` |
| `miniprogram/pages/chat/chat.js` | 发送时征集 `newMessage` |
| `test/stub/wx-server-sdk/` | 扩展：`openapi.subscribeMessage.send` 可编程失败、`_.lt/_.neq/_.gte`、`orderBy` |
| `test/notify/` | 新增：51 项离线断言 |
