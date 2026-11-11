// ══════════════════════════════════════════════════════════════
// 订阅消息模板配置 —— 服务端单一真源（Single Source of Truth）
//
// 小程序端不重复维护一份：客户端通过 notify 云函数 action='templates'
// 拉取本文件的模板 ID 映射并缓存，避免两处不一致。
//
// 【接入步骤】
//   1. 微信公众平台 → 功能 → 订阅消息 → 公共模板库，按小程序类目选用模板；
//   2. 把模板 ID 填到下面对应 key 的 id 字段；
//   3. 按模板详情页的「字段名 + 字段类型」改写 fields 映射；
//   4. 上传部署 notify 云函数，再调用 action='stats' 确认字段填充正确。
//
// 【fields 映射规则】
//   { 微信模板字段名: 取值表达式 }
//   - 'someKey'    → 取 payload.someKey；payload 中缺失则回落为占位符「无」（不会把键名当正文发出）
//   - '=固定文案'   → 以 = 开头表示字面量常量，直接使用等号后的内容
//   - 字段名后缀数字由微信给定（thing1 / phrase2 …），前缀决定类型与截断规则：
//     thing ≤20 字 / phrase ≤5 字 / character_string ≤32 字符 / time 格式化中文时间 / amount 自动补「元」
//
// 【留空即降级】
//   id 为空表示该场景未接入：入队的通知会被标记为 skipped，不影响业务主流程。
//   因此可以只接入其中一两个场景，其余保持留空。
// ══════════════════════════════════════════════════════════════

module.exports = {
  // 小程序版本：developer（开发版）/ trial（体验版）/ formal（正式版）
  // 联调期间若用体验版收通知，需改为 'trial'
  miniprogramState: 'formal',

  // 通知在队列中的最长存活时间（小时）。超时未发出即作废，避免开启模板后补发陈旧通知骚扰用户
  ttlHours: 24,

  // 系统繁忙类错误的最大重试次数（用户拒收/参数错误等不可重试错误不占用此额度）
  maxAttempts: 3,

  templates: {
    // ── 1. 收到新申请 → 通知发布方 ──
    newApplication: {
      id: '',
      page: 'pages/my-list/my-list',
      label: '收到新申请',
      fields: {
        thing1: 'dealingTitle',
        thing2: 'applicantName',
        time3: 'applyTime'
      }
    },

    // ── 2. 申请结果（通过 / 未通过）→ 通知申请方 ──
    applicationResult: {
      id: '',
      page: 'pages/my-list/my-list',
      label: '申请结果',
      fields: {
        thing1: 'dealingTitle',
        phrase2: 'resultText',
        time3: 'resultTime'
      }
    },

    // ── 3. 新私信 → 通知收信方 ──
    newMessage: {
      id: '',
      page: 'pages/messages/messages',
      label: '新私信',
      fields: {
        thing1: 'senderName',
        thing2: 'summary',
        time3: 'sendTime'
      }
    },

    // ── 4. 履约超时提醒（计时任务 72h 触发）→ 通知撮合双方 ──
    serviceReminder: {
      id: '',
      page: 'pages/my-list/my-list',
      label: '履约待确认提醒',
      fields: {
        thing1: 'dealingTitle',
        phrase2: 'reminderText',
        time3: 'deadlineTime'
      }
    },

    // ── 5. 系统自动确认完成（计时任务 96h 触发）→ 通知撮合双方 ──
    serviceAutoCompleted: {
      id: '',
      page: 'pages/my-list/my-list',
      label: '系统自动确认完成',
      fields: {
        thing1: 'dealingTitle',
        time2: 'completeTime'
      }
    },

    // ── 6. 举报处理结果 → 通知举报人 ──
    reportResult: {
      id: '',
      page: 'pages/profile/profile',
      label: '举报处理结果',
      fields: {
        phrase1: 'resultText',
        time2: 'resolveTime',
        thing3: 'note'
      }
    }
  }
}
