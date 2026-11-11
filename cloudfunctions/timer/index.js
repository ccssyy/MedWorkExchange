const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// ══════════════════════════════════════════════════════════════
// 超时兜底定时任务（对应架构设计 §3.2「超时规则（防挂单）」）
//
// 触发方式：
//   1) 定时触发器（config.json 声明，每小时一次）—— 生产路径
//   2) 手动调用：event.testKey === TEST_KEY 时允许真实写库（便于联调验证）
//   3) 只读巡检：event.action === 'scan' —— 任意调用方可执行，只统计不写库
//
// 设计约束：
//   - 服务器时间由云函数侧生成，不信任任何前端传入的时间
//   - 所有写操作带状态前置条件（乐观锁），避免与用户操作竞态覆盖
//   - 单次最多处理 MAX_BATCHES × BATCH_SIZE 条，防止函数超时
// ══════════════════════════════════════════════════════════════

const RULES = {
  // 履约应收尾后 72h 仍未获对方确认 → 打提醒标记
  REMIND_AFTER_H: 72,
  // 96h 仍未确认 → 自动确认完成（视为线下已履约）
  AUTO_CONFIRM_AFTER_H: 96,
  BATCH_SIZE: 100,          // 云开发单次 get 上限 100
  MAX_BATCHES: 10           // 单次运行最多翻 1000 条
}

// ── 扩展规则：confirmed 后长期未开始履约（超出 §3.2 原文，默认关闭）──
// 决策点：确认锁定后若双方都未点「开始履约」，单子会永久卡在 confirmed。
// 选项 1（当前实现）：到期自动关闭，不计完成、不影响信用分（保守）
// 选项 2：到期自动确认完成并计入 stats.completed，开放互评（激进）
const STALE_CONFIRMED = {
  enabled: false,
  AFTER_H: 120
}

// 与 initdb 同源的测试口令约定（非安全边界，仅防误触发）
const TEST_KEY = process.env.TEST_KEY || 'mwe-test-only'

const CLOSE_REASON_EXPIRED = 'expired_no_accept'
const CLOSE_REASON_STALE = 'stale_confirmed'

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600 * 1000)
}

async function logAudit(gate, detail) {
  await db.collection('audit_logs').add({
    data: { gate, actor: 'timer', detail, created_at: new Date() }
  }).catch(() => {})
}

// ── 通知入队（outbox 模式）：只写队列，由 notify 云函数统一出站 ──
async function enqueueNotify(fields) {
  if (!fields || !fields.to_uid) return
  try {
    const now = new Date()
    await db.collection('notifications').add({
      data: { ...fields, status: 'pending', attempts: 0, created_at: now, updated_at: now }
    })
  } catch (e) {
    console.error('[enqueueNotify] failed', e)
  }
}

// 通知撮合双方（owner + 接单方），去重后逐个入队
async function notifyBothParties(d, templateKey, payload, dedupSuffix) {
  const uids = [d.owner_uid, d.accepted_uid].filter(Boolean)
  const seen = new Set()
  for (const uid of uids) {
    if (seen.has(uid)) continue
    seen.add(uid)
    await enqueueNotify({
      to_uid: uid,
      template_key: templateKey,
      page: 'pages/detail/detail?id=' + d._id,
      payload,
      biz_type: 'dealing',
      biz_id: d._id,
      dedup_key: `${templateKey}:${d._id}:${dedupSuffix}`
    })
  }
}

// 分批取全量：云开发单次最多 100 条，需 skip 翻页
async function fetchAll(buildQuery, maxBatches = RULES.MAX_BATCHES) {
  const out = []
  for (let i = 0; i < maxBatches; i++) {
    const res = await buildQuery().skip(i * RULES.BATCH_SIZE).limit(RULES.BATCH_SIZE).get()
    out.push(...res.data)
    if (res.data.length < RULES.BATCH_SIZE) break
  }
  return out
}

// 「履约应收尾时点」：优先取接单方的完成申请时间，其次取排班结束时间。
// 注意：不取 updated_at —— 提醒动作本身会刷新 updated_at，会把锚点后推，导致永远等不到 96h。
function serviceAnchor(d) {
  if (d.complete_requested && d.complete_requested_at) return new Date(d.complete_requested_at)
  if (d.end_time) return new Date(d.end_time)
  return null
}

// ── 规则 1：published / applied 且排班时段已过仍未确认 → 自动关闭 ──
// 仅对有时段（end_time 非空）的单生效；病例指导类无排班时段，不自动关闭。
async function ruleExpireNoAccept(dryRun) {
  const now = new Date()
  const list = await fetchAll(() => db.collection('dealings').where({
    status: _.in(['published', 'applied']),
    end_time: _.lte(now)
  }))

  for (const d of list) {
    if (dryRun) continue
    // 拒绝全部待处理申请，避免申请人继续等待（与 offShelf 行为一致）
    await db.collection('applications').where({
      dealing_id: d._id, status: 'pending'
    }).update({ data: { status: 'rejected', updated_at: now } }).catch(() => {})

    // 乐观锁：仅当状态仍为 published/applied 时才落库
    await db.collection('dealings').where({
      _id: d._id, status: _.in(['published', 'applied'])
    }).update({
      data: {
        status: 'cancelled',
        close_reason: CLOSE_REASON_EXPIRED,
        closed_at: now,
        updated_at: now
      }
    }).catch(() => {})
  }

  if (!dryRun && list.length) {
    await logAudit('timer_expire', {
      count: list.length,
      reason: CLOSE_REASON_EXPIRED,
      ids: list.map(d => d._id).slice(0, 20)
    })
  }
  return list
}

// ── 规则 2：履约收尾超时 → 72h 提醒 / 96h 自动确认完成 ──
async function ruleServiceTimeout(dryRun) {
  const now = new Date()
  const cutoff = hoursAgo(RULES.REMIND_AFTER_H)

  const list = await fetchAll(() => db.collection('dealings').where(_.and([
    { status: 'in_progress' },
    _.or([
      { complete_requested_at: _.lte(cutoff) },
      { end_time: _.lte(cutoff) }
    ])
  ])))

  const reminded = []
  const autoConfirmed = []

  for (const d of list) {
    const anchor = serviceAnchor(d)
    if (!anchor || isNaN(anchor.getTime())) continue
    const ageH = (Date.now() - anchor.getTime()) / 3600000

    // 96h：自动确认完成
    if (ageH >= RULES.AUTO_CONFIRM_AFTER_H) {
      autoConfirmed.push(d._id)
      if (dryRun) continue
      const upd = await db.collection('dealings').where({
        _id: d._id, status: 'in_progress'
      }).update({
        data: {
          status: 'completed',
          completed_at: now,
          complete_requested: false,
          auto_confirmed: true,
          updated_at: now
        }
      }).catch(() => null)
      // 仅当确实由本任务完成时才计数与通知（乐观锁未命中说明用户已自行处理）
      if (upd && upd.stats && upd.stats.updated > 0) {
        if (d.accepted_uid) {
          await db.collection('users').doc(d.accepted_uid).update({
            data: { 'stats.completed': _.inc(1), updated_at: now }
          }).catch(() => {})
        }
        await notifyBothParties(d, 'serviceAutoCompleted', {
          dealingTitle: d.title || '',
          completeTime: now
        }, 'auto')
      }
      continue
    }

    // 72h：打提醒标记 + 入队订阅消息（标记位保留，供巡检与幂等判断）
    if (ageH >= RULES.REMIND_AFTER_H && !d.reminded_at) {
      reminded.push(d._id)
      if (dryRun) continue
      const updR = await db.collection('dealings').where({
        _id: d._id, status: 'in_progress'
      }).update({
        data: {
          reminded_at: now,
          remind_reason: 'service_timeout_72h',
          updated_at: now
        }
      }).catch(() => null)
      if (updR && updR.stats && updR.stats.updated > 0) {
        await notifyBothParties(d, 'serviceReminder', {
          dealingTitle: d.title || '',
          reminderText: '=待确认完成',
          deadlineTime: now
        }, '72h')
      }
    }
  }

  if (!dryRun && (reminded.length || autoConfirmed.length)) {
    await logAudit('timer_service_timeout', {
      reminded: reminded.length,
      autoConfirmed: autoConfirmed.length,
      autoConfirmedIds: autoConfirmed.slice(0, 20)
    })
  }
  return { reminded, autoConfirmed }
}

// ── 规则 3（扩展，默认关闭）：confirmed 后长期未开始履约 ──
async function ruleStaleConfirmed(dryRun) {
  if (!STALE_CONFIRMED.enabled) return []
  const now = new Date()
  const list = await fetchAll(() => db.collection('dealings').where({
    status: 'confirmed',
    end_time: _.lte(hoursAgo(STALE_CONFIRMED.AFTER_H))
  }))

  for (const d of list) {
    if (dryRun) continue
    await db.collection('dealings').where({
      _id: d._id, status: 'confirmed'
    }).update({
      data: {
        status: 'cancelled',
        close_reason: CLOSE_REASON_STALE,
        closed_at: now,
        updated_at: now
      }
    }).catch(() => {})
  }

  if (!dryRun && list.length) {
    await logAudit('timer_stale_confirmed', {
      count: list.length,
      reason: CLOSE_REASON_STALE,
      ids: list.map(d => d._id).slice(0, 20)
    })
  }
  return list
}

exports.main = async (event = {}) => {
  const isTrigger = event.Type === 'Timer' || event.type === 'timer'
  const dryRun = event.action === 'scan' || event.dryRun === true

  // 写库路径：必须来自定时触发器，或携带正确 testKey 的手动联调
  if (!dryRun && !isTrigger && event.testKey !== TEST_KEY) {
    return { ok: false, code: 'FORBIDDEN', message: '定时任务仅可由触发器执行' }
  }

  const startedAt = Date.now()
  try {
    const expired = await ruleExpireNoAccept(dryRun)
    const { reminded, autoConfirmed } = await ruleServiceTimeout(dryRun)
    const stale = await ruleStaleConfirmed(dryRun)

    return {
      ok: true,
      dryRun,
      trigger: isTrigger,
      rules: {
        remindAfterHours: RULES.REMIND_AFTER_H,
        autoConfirmAfterHours: RULES.AUTO_CONFIRM_AFTER_H,
        staleConfirmedRuleEnabled: STALE_CONFIRMED.enabled
      },
      summary: {
        expiredNoAccept: expired.length,
        reminded72h: reminded.length,
        autoConfirmed96h: autoConfirmed.length,
        staleConfirmed: stale.length
      },
      sample: {
        expired: expired.map(d => d._id).slice(0, 10),
        reminded: reminded.slice(0, 10),
        autoConfirmed: autoConfirmed.slice(0, 10),
        stale: stale.map(d => d._id).slice(0, 10)
      },
      elapsedMs: Date.now() - startedAt
    }
  } catch (e) {
    console.error('[timer] run failed', e)
    await logAudit('timer_error', { message: e.message, stack: String(e.stack || '').slice(0, 500) })
    return { ok: false, code: 'TIMER_FAIL', message: e.message, elapsedMs: Date.now() - startedAt }
  }
}
