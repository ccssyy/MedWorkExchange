const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action

  async function getUser() {
    const found = await db.collection('users').where({ openid: OPENID }).get()
    return found.data[0] || null
  }

  // ── 申请接单/预约 ──
  if (action === 'apply') {
    const user = await getUser()
    if (!user) return { ok: false, code: 'NO_USER', message: '请先登录' }
    if (user.verify_status !== 'verified') {
      return { ok: false, code: 'NOT_VERIFIED', message: '请先完成医院认证' }
    }

    const { dealingId, message } = event
    const d = await db.collection('dealings').doc(dealingId).get().catch(() => null)
    if (!d || !d.data) return { ok: false, message: '撮合单不存在' }
    const dealing = d.data

    // 医院隔离：申请方必须与撮合单同院（不信前端）
    if (dealing.hospital_id !== user.hospital_id) {
      return { ok: false, code: 'CROSS_HOSPITAL', message: '只能申请本院的撮合单' }
    }
    // 不能申请自己的单
    if (dealing.owner_uid === user._id) {
      return { ok: false, message: '不能申请自己发布的撮合单' }
    }
    // 状态机：仅 published / applied 可申请
    if (!['published', 'applied'].includes(dealing.status)) {
      return { ok: false, message: '该撮合单当前不可申请' }
    }
    // 防重复
    const dup = await db.collection('applications').where({
      dealing_id: dealingId, applicant_uid: user._id,
      status: _.in(['pending', 'accepted'])
    }).count()
    if (dup.total > 0) return { ok: false, message: '已申请过，请等待发布方确认' }

    const now = new Date()
    await db.collection('applications').add({
      data: {
        dealing_id: dealingId,
        applicant_uid: user._id,
        applicant_nickname: user.nickname || '',
        applicant_credit: user.credit_score == null ? 100 : user.credit_score,
        applicant_completed: (user.stats && user.stats.completed) || 0,
        message: String(message || '').trim().slice(0, 100),
        status: 'pending',
        created_at: now,
        updated_at: now
      }
    })
    // 撮合单迁移到 applied
    await db.collection('dealings').doc(dealingId).update({
      data: { status: 'applied', updated_at: now }
    })
    // TODO(M3): 订阅消息通知发布方"收到新申请"
    return { ok: true }
  }

  // ── 发布方确认候选人 ──
  if (action === 'accept') {
    const user = await getUser()
    if (!user) return { ok: false, message: '请先登录' }

    const { applicationId } = event
    const a = await db.collection('applications').doc(applicationId).get().catch(() => null)
    if (!a || !a.data) return { ok: false, message: '申请不存在' }
    const app = a.data

    const d = await db.collection('dealings').doc(app.dealing_id).get().catch(() => null)
    if (!d || !d.data) return { ok: false, message: '撮合单不存在' }
    const dealing = d.data

    // 只有发布方能确认
    if (dealing.owner_uid !== user._id) {
      return { ok: false, code: 'FORBIDDEN', message: '只有发布方可以确认' }
    }
    // 状态机：仅 applied 可确认
    if (dealing.status !== 'applied') {
      return { ok: false, message: '撮合单当前状态不可确认' }
    }

    const now = new Date()
    // 选中的申请 → accepted
    await db.collection('applications').doc(applicationId).update({
      data: { status: 'accepted', updated_at: now }
    })
    // 其余 pending 申请 → rejected
    await db.collection('applications').where({
      dealing_id: app.dealing_id, status: 'pending'
    }).update({
      data: { status: 'rejected', updated_at: now }
    })
    // 撮合单 → confirmed，记录接单方
    await db.collection('dealings').doc(app.dealing_id).update({
      data: {
        status: 'confirmed',
        accepted_uid: app.applicant_uid,
        accepted_nickname: app.applicant_nickname,
        updated_at: now
      }
    })
    // 自动创建会话（私信前置条件）
    await ensureConversation(dealing, app, now)
    // TODO(M3): 订阅消息通知接单方"申请已通过"
    return { ok: true }
  }

  // ── 取消申请（confirmed 前）──
  if (action === 'cancel') {
    const user = await getUser()
    if (!user) return { ok: false, message: '请先登录' }
    const { applicationId } = event
    const a = await db.collection('applications').doc(applicationId).get().catch(() => null)
    if (!a || !a.data) return { ok: false, message: '申请不存在' }
    if (a.data.applicant_uid !== user._id) return { ok: false, code: 'FORBIDDEN', message: '只能取消自己的申请' }
    if (a.data.status !== 'pending') return { ok: false, message: '该申请当前不可取消' }

    const now = new Date()
    await db.collection('applications').doc(applicationId).update({
      data: { status: 'cancelled', updated_at: now }
    })
    // 若撮合单已无 pending 申请，回落到 published
    const remain = await db.collection('applications').where({
      dealing_id: a.data.dealing_id, status: 'pending'
    }).count()
    if (remain.total === 0) {
      const d = await db.collection('dealings').doc(a.data.dealing_id).get()
      if (d.data && d.data.status === 'applied') {
        await db.collection('dealings').doc(a.data.dealing_id).update({
          data: { status: 'published', updated_at: now }
        })
      }
    }
    return { ok: true }
  }

  return { ok: false, message: '未知 action' }
}

async function ensureConversation(dealing, app, now) {
  const exist = await db.collection('conversations').where({ dealing_id: dealing._id }).count()
  if (exist.total > 0) return
  await db.collection('conversations').add({
    data: {
      dealing_id: dealing._id,
      dealing_title: dealing.title,
      a_uid: dealing.owner_uid,
      b_uid: app.applicant_uid,
      last_message: '',
      last_time: now,
      created_at: now
    }
  })
}
