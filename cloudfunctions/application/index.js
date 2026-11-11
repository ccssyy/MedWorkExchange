const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// ── 通知入队（outbox 模式）──
// 业务函数只写入队、不直接调用微信接口：发送失败不会阻塞业务，且只有 notify 云函数需要
// 声明 subscribeMessage.send 云调用权限。队列由 notify 定时出站。失败静默，不影响主流程。
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
    // 患者角色只能发单/确认，不能申请接单
    if (user.role === 'patient') {
      return { ok: false, code: 'PATIENT_FORBIDDEN', message: '患者身份仅可发布陪诊需求，不能接单' }
    }
    if (user.verify_status !== 'verified') {
      return { ok: false, code: 'NOT_VERIFIED', message: '请先完成医院认证' }
    }
    // 信用分门槛（M3：低于 60 限制申请）
    if ((user.credit_score == null ? 100 : user.credit_score) < 60) {
      return { ok: false, code: 'LOW_CREDIT', message: '信用分过低，暂时无法申请（如有误请申诉）' }
    }

    const { dealingId, message } = event
    const d = await db.collection('dealings').doc(dealingId).get().catch(() => null)
    if (!d || !d.data) return { ok: false, message: '撮合单不存在' }
    const dealing = d.data

    // D8：跨院申请放开（规培实习生跨院帮忙是核心场景）
    // 申请人所属医院/科室写入快照，由发布方自行判断是否接受
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

    // 内容安全三级管线同源（申请留言会展示给单主）：本地黑名单 + 隐私正则 → msgSecCheck
    const msg = String(message || '').trim().slice(0, 100)
    if (msg) {
      const LOCAL_BLACKLIST = [
        '法轮功', '赌博', '代开发票', '毒品', '冰毒', '枪支', '买微信号',
        '加微信', '加V', '微信号', '转账到', '刷单', '代办证书'
      ]
      const PRIVACY_PATTERNS = [/\d{17}[\dXx]/, /1[3-9]\d{9}/]
      for (const w of LOCAL_BLACKLIST) {
        if (msg.includes(w)) {
          return { ok: false, code: 'RISK_CONTENT', message: '留言含违规词，请修改' }
        }
      }
      for (const p of PRIVACY_PATTERNS) {
        if (p.test(msg.replace(/[\s-]/g, ''))) {
          return { ok: false, code: 'RISK_PRIVACY', message: '留言含手机号/身份证等隐私信息，请修改' }
        }
      }
      try {
        await cloud.openapi.security.msgSecCheck({
          openid: OPENID, scene: 2, version: 2, content: msg
        })
      } catch (e) {
        if (e.errCode === 87014) return { ok: false, code: 'RISK_CONTENT', message: '留言含违规信息，请修改' }
        console.error('msgSecCheck error', e)
        return { ok: false, code: 'SEC_CHECK_FAIL', message: '系统繁忙，请稍后重试' }
      }
    }

    const now = new Date()
    await db.collection('applications').add({
      data: {
        dealing_id: dealingId,
        applicant_uid: user._id,
        applicant_nickname: user.nickname || '',
        applicant_hospital: user.hospitalName || '',
        applicant_department: user.department || '',
        applicant_credit: user.credit_score == null ? 100 : user.credit_score,
        applicant_completed: (user.stats && user.stats.completed) || 0,
        message: msg,
        status: 'pending',
        created_at: now,
        updated_at: now
      }
    })
    // 撮合单迁移到 applied
    await db.collection('dealings').doc(dealingId).update({
      data: { status: 'applied', updated_at: now }
    })
    // 订阅消息：通知发布方「收到新申请」
    await enqueueNotify({
      to_uid: dealing.owner_uid,
      template_key: 'newApplication',
      page: 'pages/my-list/my-list',
      payload: {
        dealingTitle: dealing.title || '',
        applicantName: user.nickname || '医同学',
        applyTime: now
      },
      biz_type: 'dealing',
      biz_id: dealingId,
      dedup_key: `newApplication:${dealingId}:${user._id}`
    })
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
    // 其余 pending 申请 → rejected（先取名单，供后续通知「未通过」）
    const others = await db.collection('applications').where({
      dealing_id: app.dealing_id, status: 'pending'
    }).get()
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

    // 订阅消息：通知申请方「已通过」
    await enqueueNotify({
      to_uid: app.applicant_uid,
      template_key: 'applicationResult',
      page: 'pages/detail/detail?id=' + app.dealing_id,
      payload: {
        dealingTitle: dealing.title || '',
        resultText: '=已通过',
        resultTime: now
      },
      biz_type: 'dealing',
      biz_id: app.dealing_id,
      dedup_key: `applicationResult:${applicationId}:accepted`
    })
    // 订阅消息：通知其余候选「未通过」
    for (const o of others.data || []) {
      await enqueueNotify({
        to_uid: o.applicant_uid,
        template_key: 'applicationResult',
        page: 'pages/my-list/my-list',
        payload: {
          dealingTitle: dealing.title || '',
          resultText: '=未通过',
          resultTime: now
        },
        biz_type: 'dealing',
        biz_id: app.dealing_id,
        dedup_key: `applicationResult:${o._id}:rejected`
      })
    }
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
