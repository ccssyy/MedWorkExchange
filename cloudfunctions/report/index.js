const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const CREDIT_REPORT_PENALTY = 20   // 举报成立：被举报人 -20（设计文档信用分规则）

// ── 举报原因枚举 ──
const REASONS = ['fake', 'illegal', 'harass', 'fraud', 'medical_violation', 'other']
const REASON_LABELS = {
  fake: '虚假信息',
  illegal: '违法违规内容',
  harass: '骚扰/辱骂',
  fraud: '欺诈行为',
  medical_violation: '医疗违规（加号/插队/诊疗行为）',
  other: '其他'
}

// 与 posts/dealing/message/review 同源的本地黑名单 + 隐私正则（三级管线第一道）
const LOCAL_BLACKLIST = [
  '法轮功', '赌博', '代开发票', '毒品', '冰毒', '枪支', '买微信号',
  '加微信', '加V', '微信号', '转账到', '刷单', '代办证书'
]
const PRIVACY_PATTERNS = [
  /\d{17}[\dXx]/,
  /1[3-9]\d{9}/
]

// 三级管线：本地黑名单 + 隐私正则 → msgSecCheck v2（举报描述同源审核）
async function secCheckText(openid, text) {
  for (const w of LOCAL_BLACKLIST) {
    if (text.includes(w)) {
      return { ok: false, code: 'RISK_CONTENT', message: '描述含违规词，请修改' }
    }
  }
  for (const p of PRIVACY_PATTERNS) {
    if (p.test(text.replace(/[\s-]/g, ''))) {
      return { ok: false, code: 'RISK_PRIVACY', message: '描述含手机号/身份证等隐私信息，请删除后重试' }
    }
  }
  try {
    await cloud.openapi.security.msgSecCheck({
      openid, scene: 2, version: 2, content: text.slice(0, 200)
    })
    return { ok: true }
  } catch (e) {
    if (e.errCode === 87014) return { ok: false, code: 'RISK_CONTENT', message: '描述含违规信息，请修改' }
    console.error('msgSecCheck error', e)
    return { ok: false, code: 'SEC_CHECK_FAIL', message: '系统繁忙，请稍后重试' }
  }
}

async function getUser() {
  const found = await db.collection('users').where({ openid: OPENID_OF }).get()
  return found.data[0] || null
}

let OPENID_OF = null

// ── 拉取举报目标（校验存在性 + 生成快照 + 确定被举报人）──
async function loadTarget(targetType, targetId, me) {
  if (targetType === 'dealing') {
    const r = await db.collection('dealings').doc(targetId).get().catch(() => null)
    if (!r || !r.data) return null
    const d = r.data
    // 被举报人：我是单主 → 举报接单方；我是接单方 → 举报单主；路人 → 举报单主（已锁定则接单方）
    let reportedUid
    if (d.owner_uid === me._id) {
      reportedUid = d.accepted_uid || null
    } else if (d.accepted_uid === me._id) {
      reportedUid = d.owner_uid
    } else {
      reportedUid = d.accepted_uid || d.owner_uid
    }
    if (!reportedUid) return { nothing: true }
    return {
      reportedUid,
      snapshot: { title: d.title || '', detail: String(d.description || d.detail || '').slice(0, 50) },
      status: d.status
    }
  }
  if (targetType === 'post') {
    const r = await db.collection('posts').doc(targetId).get().catch(() => null)
    if (!r || !r.data) return null
    const p = r.data
    if (p.author_uid === me._id) return { self: true }
    return {
      reportedUid: p.author_uid,
      snapshot: { title: p.title || '', detail: String(p.content || '').slice(0, 50) },
      status: p.status
    }
  }
  if (targetType === 'message') {
    const r = await db.collection('messages').doc(targetId).get().catch(() => null)
    if (!r || !r.data) return null
    const m = r.data
    if (m.from_uid === me._id) return { self: true }
    // 仅会话双方可举报该消息
    const conv = await db.collection('conversations').doc(m.conversation_id).get().catch(() => null)
    if (!conv || !conv.data || (conv.data.a_uid !== me._id && conv.data.b_uid !== me._id)) {
      return { forbidden: true }
    }
    return {
      reportedUid: m.from_uid,
      snapshot: { title: '私信消息', detail: String(m.content || '').slice(0, 50) },
      status: ''
    }
  }
  if (targetType === 'user') {
    const r = await db.collection('users').doc(targetId).get().catch(() => null)
    if (!r || !r.data) return null
    if (targetId === me._id) return { self: true }
    return {
      reportedUid: targetId,
      snapshot: { title: '用户', detail: r.data.nickname || '' },
      status: ''
    }
  }
  return null
}

// ── 仲裁成立时的下架动作 ──
async function takedownTarget(report) {
  const now = new Date()
  const { target_type, target_id } = report
  if (target_type === 'post') {
    await db.collection('posts').doc(target_id).update({
      data: { status: 'deleted', deleted_at: now, updated_at: now }
    }).catch(() => {})
    // 帖子下架连带其评论不可见（comments 随 status 过滤）
  } else if (target_type === 'dealing') {
    await db.collection('dealings').doc(target_id).update({
      data: { status: 'cancelled', deleted_at: now, cancel_reason: 'report_upheld', updated_at: now }
    }).catch(() => {})
  } else if (target_type === 'message') {
    await db.collection('messages').doc(target_id).update({
      data: { flagged: true, content: '[该消息因违规已被屏蔽]', updated_at: now }
    }).catch(() => {})
  }
  // user 类型：仅信用分处置（下方统一扣分），账号封禁联调期不做
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  OPENID_OF = OPENID
  const action = event.action
  const user = await getUser()
  if (!user) return { ok: false, message: '请先登录' }

  // ════════ 提交举报 ════════
  if (action === 'submit') {
    const { targetType, targetId, reason, description, evidence } = event
    if (!REASONS.includes(reason)) return { ok: false, message: '请选择举报原因' }
    const desc = String(description || '').trim().slice(0, 200)

    const t = await loadTarget(targetType, targetId, user)
    if (!t) return { ok: false, message: '举报对象不存在' }
    if (t.self) return { ok: false, message: '不能举报自己' }
    if (t.nothing) return { ok: false, message: '暂无可举报的对象' }
    if (t.forbidden) return { ok: false, code: 'FORBIDDEN', message: '无权举报该内容' }

    // 防重：同一人对同一对象，存在未办结的举报则不重复受理
    const dup = await db.collection('reports').where({
      reporter_uid: user._id,
      target_type: targetType,
      target_id: targetId,
      status: _.in(['open', 'processing'])
    }).count()
    if (dup.total > 0) return { ok: false, code: 'DUP', message: '该内容已在处理中，请勿重复提交' }

    // 描述同源审核
    if (desc) {
      const sec = await secCheckText(OPENID, desc)
      if (!sec.ok) return sec
    }

    const now = new Date()
    const added = await db.collection('reports').add({
      data: {
        target_type: targetType,
        target_id: targetId,
        target_snapshot: t.snapshot,
        reporter_uid: user._id,
        reported_uid: t.reportedUid,
        reason,
        reason_label: REASON_LABELS[reason],
        description: desc,
        evidence: Array.isArray(evidence) ? evidence.slice(0, 3) : [],
        status: 'open',
        result: '',
        resolve_note: '',
        created_at: now,
        resolved_at: null
      }
    })
    return { ok: true, reportId: added._id, message: '举报已提交，平台将尽快处理' }
  }

  // ════════ 我提交的举报（处理进度闭环）════════
  if (action === 'myReports') {
    const res = await db.collection('reports').where({
      reporter_uid: user._id
    }).orderBy('created_at', 'desc').limit(20).get()
    return {
      ok: true,
      reports: res.data.map(r => ({
        _id: r._id,
        targetType: r.target_type,
        snapshot: r.target_snapshot,
        reasonLabel: r.reason_label,
        status: r.status,
        result: r.result,
        resolvedAt: r.resolved_at
      }))
    }
  }

  // ════════ 以下为管理员仲裁接口 ════════
  if (!user.is_admin) return { ok: false, code: 'FORBIDDEN', message: '需要管理员权限' }

  // ── 待处理列表 ──
  if (action === 'adminList') {
    const { status } = event
    const where = status ? { status } : { status: _.in(['open', 'processing']) }
    const res = await db.collection('reports').where(where)
      .orderBy('created_at', 'asc').limit(50).get()
    const list = []
    for (const r of res.data) {
      const reporter = r.reporter_uid
        ? await db.collection('users').doc(r.reporter_uid).get().catch(() => null) : null
      const reported = r.reported_uid
        ? await db.collection('users').doc(r.reported_uid).get().catch(() => null) : null
      list.push({
        _id: r._id,
        targetType: r.target_type,
        targetId: r.target_id,
        snapshot: r.target_snapshot,
        reasonLabel: r.reason_label,
        description: r.description,
        evidence: r.evidence,
        status: r.status,
        reporterName: (reporter && reporter.data && reporter.data.nickname) || '?',
        reportedName: (reported && reported.data && reported.data.nickname) || '?',
        reportedCredit: (reported && reported.data && (reported.data.credit_score == null ? 100 : reported.data.credit_score)),
        createdAt: r.created_at
      })
    }
    return { ok: true, list }
  }

  // ── 仲裁裁决 ──
  if (action === 'adminResolve') {
    const { reportId, upheld, note } = event
    if (!reportId || typeof upheld !== 'boolean') return { ok: false, message: '参数缺失' }
    const r = await db.collection('reports').doc(reportId).get().catch(() => null)
    if (!r || !r.data) return { ok: false, message: '举报记录不存在' }
    const report = r.data
    if (report.status === 'resolved') return { ok: false, code: 'RESOLVED', message: '该举报已办结' }

    const now = new Date()
    if (upheld) {
      // 成立：内容下架 + 被举报人信用分 -20（被举报人缺失时只下架）
      await takedownTarget(report)
      if (report.reported_uid) {
        await db.collection('users').doc(report.reported_uid).update({
          data: { credit_score: _.inc(-CREDIT_REPORT_PENALTY), updated_at: now }
        }).catch(() => {})
      }
      await db.collection('reports').doc(reportId).update({
        data: { status: 'resolved', result: 'upheld', resolve_note: String(note || '').slice(0, 100), resolved_at: now, resolved_by: user._id }
      })
      return { ok: true, result: 'upheld', message: `已下架并扣除被举报人 ${CREDIT_REPORT_PENALTY} 信用分` }
    }
    // 不成立：驳回
    await db.collection('reports').doc(reportId).update({
      data: { status: 'resolved', result: 'rejected', resolve_note: String(note || '').slice(0, 100), resolved_at: now, resolved_by: user._id }
    })
    return { ok: true, result: 'rejected', message: '已驳回该举报' }
  }

  return { ok: false, message: '未知 action' }
}
