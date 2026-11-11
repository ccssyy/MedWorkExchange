const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const TPL = require('./templates')

// ══════════════════════════════════════════════════════════════
// notify —— 订阅消息统一出站（Outbox 模式）
//
// 业务云函数只向 notifications 集合「入队」，不直接调用微信接口：
//   application / message / report / timer  ──入队──> notifications
//                                                          │
//                                        notify.drain ─────┘──> subscribeMessage.send
//
// 这样做的三个理由：
//   1) 只有本函数需要声明 subscribeMessage.send 云调用权限，其余函数保持干净；
//   2) 发送失败绝不阻塞业务（用户申请成功不该因为通知失败而报错）；
//   3) 失败原因、重试、限流集中一处可观测。
//
// 触发：定时触发器每 5 分钟 drain 一次（config.json）
// 手动：action='drain' 需 testKey；action='send' 联调单发；action='stats' 看队列
// 客户端：action='templates' 拉模板 ID（无鉴权，仅返回 ID 映射，非敏感）
// ══════════════════════════════════════════════════════════════

const TEST_KEY = process.env.TEST_KEY || 'mwe-test-only'
const BATCH_SIZE = 50
const MAX_BATCHES = 5

// 不可重试的错误：重试没有意义，直接定性
const NON_RETRYABLE = {
  43101: { status: 'skipped', reason: 'user_refused' },     // 用户拒绝接收 / 未订阅
  40003: { status: 'failed', reason: 'invalid_openid' },    // openid 无效
  47003: { status: 'failed', reason: 'bad_params' },        // 参数不合法（模板字段映射需核对）
  41030: { status: 'failed', reason: 'page_not_exists' }    // 跳转页不存在
}

function pad2(n) { return String(n).padStart(2, '0') }

function toTimeStr(v) {
  const d = v instanceof Date ? v : new Date(v)
  if (isNaN(d.getTime())) return v == null ? '' : String(v)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function toDateStr(v) {
  const d = v instanceof Date ? v : new Date(v)
  if (isNaN(d.getTime())) return v == null ? '' : String(v)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

// 从字段名解析微信字段类型：thing1 → thing
function fieldType(key) {
  const m = /^([a-z_]+)\d+$/.exec(String(key))
  return m ? m[1] : ''
}

function cut(s, n) {
  const arr = Array.from(String(s == null ? '' : s))
  return arr.length <= n ? arr.join('') : arr.slice(0, n).join('')
}

// 按字段类型清洗数值：微信对每类字段有硬性长度/字符集要求，越界会直接报 47003
function sanitize(key, raw) {
  const t = fieldType(key)
  const s = raw == null ? '' : String(raw)
  switch (t) {
    case 'thing': return cut(s, 20) || '无'
    case 'phrase': return cut(s, 5) || '无'
    case 'character_string': return cut(s.replace(/[^0-9A-Za-z]/g, ''), 32) || '0'
    case 'number': return s.replace(/[^\d.]/g, '') || '0'
    case 'amount': {
      const num = s.replace(/[^\d.]/g, '')
      return num ? num + '元' : '0元'
    }
    case 'phone_number': return s.replace(/[^\d]/g, '').slice(0, 11) || '0'
    case 'time': return toTimeStr(raw) || '无'
    case 'date': return toDateStr(raw) || '无'
    case 'letter':
    case 'symbol': return cut(s, 20) || '无'
    default: return cut(s, 20) || '无'
  }
}

// 取值表达式：
//   '=固定文案'  → 字面量（显式标记，避免与 payload 键名混淆）
//   'someKey'   → 取 payload.someKey；缺失返回 undefined，由 sanitize 回落占位符
// 刻意不做「缺失时回退为映射键名」——那会把 'dealingTitle' 这样的键名当成正文发给用户。
function resolveValue(payload, expr) {
  const e = String(expr == null ? '' : expr)
  if (e.charAt(0) === '=') return e.slice(1)
  if (payload && Object.prototype.hasOwnProperty.call(payload, e)) return payload[e]
  return undefined
}

function buildData(tpl, payload) {
  const data = {}
  const fields = tpl.fields || {}
  for (const key of Object.keys(fields)) {
    data[key] = { value: sanitize(key, resolveValue(payload, fields[key])) }
  }
  return data
}

function activeKeys() {
  return Object.keys(TPL.templates).filter(k => TPL.templates[k] && TPL.templates[k].id)
}

function bump(summary, reason) {
  summary.reasons[reason] = (summary.reasons[reason] || 0) + 1
}

async function mark(n, patch, dryRun, now) {
  if (dryRun) return
  await db.collection('notifications').doc(n._id).update({
    data: { ...patch, updated_at: now }
  }).catch(() => {})
}

// 处理单条待发通知
async function processOne(n, ctx) {
  const { dryRun, now, summary } = ctx

  const tpl = TPL.templates[n.template_key]
  if (!tpl) {
    summary.failed++; bump(summary, 'unknown_template')
    return mark(n, { status: 'failed', last_error_msg: 'unknown_template' }, dryRun, now)
  }
  if (!tpl.id) {
    summary.skipped++; bump(summary, 'template_id_missing')
    return mark(n, { status: 'skipped', last_error_msg: 'template_id_missing' }, dryRun, now)
  }

  // TTL：过期通知作废，避免模板配置补齐后补发陈旧消息骚扰用户
  const ageH = (now.getTime() - new Date(n.created_at).getTime()) / 3600000
  if (ageH > TPL.ttlHours) {
    summary.skipped++; bump(summary, 'expired')
    return mark(n, { status: 'skipped', last_error_msg: 'expired' }, dryRun, now)
  }

  // 解析接收方 openid（入队时只记 uid，发送时才解析，避免 openid 快照过期）
  const u = await db.collection('users').doc(n.to_uid).get().catch(() => null)
  const openid = u && u.data ? u.data.openid : ''
  if (!openid) {
    summary.failed++; bump(summary, 'no_openid')
    return mark(n, { status: 'failed', last_error_msg: 'no_openid' }, dryRun, now)
  }

  const page = n.page || tpl.page || ''
  const data = buildData(tpl, n.payload || {})

  if (dryRun) {
    summary.sent++
    return
  }

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: tpl.id,
      page,
      data,
      miniprogramState: TPL.miniprogramState,
      lang: 'zh_CN'
    })
    summary.sent++
    await mark(n, { status: 'sent', sent_at: now, last_error_code: null, last_error_msg: null }, dryRun, now)
  } catch (e) {
    const code = Number(e.errCode || e.errcode || 0)
    const msg = String(e.errMsg || e.message || '').slice(0, 200)
    const cls = NON_RETRYABLE[code]
    if (cls) {
      summary[cls.status === 'skipped' ? 'skipped' : 'failed']++
      bump(summary, cls.reason)
      await mark(n, {
        status: cls.status, last_error_code: code, last_error_msg: cls.reason + ' | ' + msg
      }, dryRun, now)
      return
    }

    // 其余按可重试处理（系统繁忙 / 接口频率限制等）
    const attempts = (n.attempts || 0) + 1
    if (attempts >= TPL.maxAttempts) {
      summary.failed++; bump(summary, 'retry_exhausted')
      await mark(n, {
        status: 'failed', attempts, last_error_code: code, last_error_msg: 'retry_exhausted | ' + msg
      }, dryRun, now)
    } else {
      summary.retry++; bump(summary, 'retryable')
      await mark(n, {
        status: 'pending', attempts, last_error_code: code, last_error_msg: msg
      }, dryRun, now)
    }
  }
}

async function drain({ dryRun = false } = {}) {
  const now = new Date()
  const configured = activeKeys()
  const summary = {
    dryRun,
    configuredTemplates: configured,
    picked: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    retry: 0,
    reasons: {}
  }

  // 模板全未配置：不发送，并把积压 pending 作废（避免开启后补发陈旧通知）
  if (!configured.length) {
    const cnt = await db.collection('notifications').where({ status: 'pending' }).count()
    summary.picked = cnt.total
    if (!dryRun && cnt.total > 0) {
      const r = await db.collection('notifications').where({ status: 'pending' }).update({
        data: { status: 'skipped', last_error_msg: 'templates_not_configured', updated_at: now }
      })
      summary.skipped = (r.stats && r.stats.updated) || 0
      bump(summary, 'templates_not_configured')
    }
    summary.note = '未配置任何模板 ID，见 cloudfunctions/notify/templates.js'
    return summary
  }

  for (let b = 0; b < MAX_BATCHES; b++) {
    const res = await db.collection('notifications').where({ status: 'pending' })
      .orderBy('created_at', 'asc').limit(BATCH_SIZE).get()
    if (!res.data.length) break

    for (const n of res.data) {
      summary.picked++
      await processOne(n, { dryRun, now, summary })
    }
    if (dryRun) break
    if (res.data.length < BATCH_SIZE) break
  }
  return summary
}

// 联调单发：跳过队列，直接按模板发一条，便于核对字段映射
async function sendNow(event) {
  const { toUid, toOpenid, templateKey, payload = {}, page } = event
  const tpl = TPL.templates[templateKey]
  if (!tpl) return { ok: false, code: 'NO_TEMPLATE', message: '未知模板 key: ' + templateKey }
  if (!tpl.id) return { ok: false, code: 'NO_TEMPLATE_ID', message: '该模板尚未填写 ID' }

  let openid = toOpenid || ''
  if (!openid && toUid) {
    const u = await db.collection('users').doc(toUid).get().catch(() => null)
    openid = u && u.data ? u.data.openid : ''
  }
  if (!openid) return { ok: false, code: 'NO_OPENID', message: '未找到接收方 openid' }

  const data = buildData(tpl, payload)
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: tpl.id,
      page: page || tpl.page || '',
      data,
      miniprogramState: TPL.miniprogramState,
      lang: 'zh_CN'
    })
    return { ok: true, sentTo: openid, templateKey, data }
  } catch (e) {
    return {
      ok: false,
      code: 'SEND_FAIL',
      errCode: e.errCode || e.errcode || 0,
      message: String(e.errMsg || e.message || ''),
      dataSent: data
    }
  }
}

exports.main = async (event = {}) => {
  const action = event.action || 'drain'
  const isTrigger = event.Type === 'Timer' || event.type === 'timer'

  // ── 客户端拉取模板 ID（无鉴权：仅返回 ID 映射，无敏感信息）──
  if (action === 'templates') {
    const ids = {}
    for (const k of activeKeys()) ids[k] = TPL.templates[k].id
    return { ok: true, configured: activeKeys(), ids, miniprogramState: TPL.miniprogramState }
  }

  // ── 只读队列观测（需 testKey）──
  if (action === 'stats') {
    if (event.testKey !== TEST_KEY) {
      return { ok: false, code: 'FORBIDDEN', message: 'stats 需要 testKey' }
    }
    const counts = {}
    for (const s of ['pending', 'sent', 'skipped', 'failed']) {
      const r = await db.collection('notifications').where({ status: s }).count()
      counts[s] = r.total
    }
    const recent = await db.collection('notifications').where({ status: _.in(['failed', 'skipped']) })
      .orderBy('updated_at', 'desc').limit(10).get()
    return {
      ok: true,
      configuredTemplates: activeKeys(),
      counts,
      recentProblems: recent.data.map(x => ({
        templateKey: x.template_key,
        status: x.status,
        attempts: x.attempts || 0,
        error: x.last_error_msg || '',
        at: x.updated_at
      }))
    }
  }

  // ── 联调单发（需 testKey）──
  if (action === 'send') {
    if (event.testKey !== TEST_KEY) {
      return { ok: false, code: 'FORBIDDEN', message: 'send 需要 testKey' }
    }
    return sendNow(event)
  }

  // ── 出站（默认）：触发器或 testKey ──
  const dryRun = action === 'scan' || event.dryRun === true
  if (!dryRun && !isTrigger && event.testKey !== TEST_KEY) {
    return { ok: false, code: 'FORBIDDEN', message: 'notify drain 仅可由触发器执行' }
  }

  const startedAt = Date.now()
  const summary = await drain({ dryRun })
  return { ok: true, trigger: isTrigger, elapsedMs: Date.now() - startedAt, ...summary }
}
