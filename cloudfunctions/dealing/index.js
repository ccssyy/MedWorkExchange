const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ALLOWED_CATEGORIES = ['shift', 'case_guide', 'resume_guide']
const ALLOWED_TYPES = ['requirement', 'service']

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'

  // 当前用户档案（写操作与身份校验的依据）
  async function getUser() {
    const found = await db.collection('users').where({ openid: OPENID }).get()
    return found.data[0] || null
  }

  // ── 列表：只返回指定医院的撮合单（隔离只读面）──
  if (action === 'list') {
    const { hospitalId, category, type, status } = event
    if (!hospitalId) return { ok: false, message: '缺少 hospitalId' }
    const where = { hospital_id: hospitalId }
    if (category && ALLOWED_CATEGORIES.includes(category)) where.category = category
    if (type && ALLOWED_TYPES.includes(type)) where.type = type
    if (status) where.status = status
    const res = await db.collection('dealings')
      .where(where)
      .orderBy('created_at', 'desc')
      .limit(50)
      .get()
    return {
      dealings: res.data.map(d => ({
        _id: d._id,
        type: d.type,
        category: d.category,
        title: d.title,
        detail: d.detail,
        schedule: d.schedule,
        fee: d.fee,
        status: d.status,
        ownerUid: d.owner_uid,
        createdAt: d.created_at
      }))
    }
  }

  // ── 详情：撮合单 + 申请人列表（仅发布方可见完整申请人；申请方只见自己）──
  if (action === 'get') {
    const { dealingId } = event
    if (!dealingId) return { ok: false, message: '缺少 dealingId' }
    const d = await db.collection('dealings').doc(dealingId).get().catch(() => null)
    if (!d || !d.data) return { ok: false, message: '撮合单不存在' }
    const dealing = d.data

    const user = await getUser()
    const isOwner = !!(user && user._id === dealing.owner_uid)
    const myHospitalId = user ? user.hospital_id : null
    const crossHospital = !!(user && user.verify_status === 'verified' && myHospitalId && myHospitalId !== dealing.hospital_id)

    let applications = []
    if (isOwner) {
      const res = await db.collection('applications')
        .where({ dealing_id: dealingId })
        .orderBy('created_at', 'desc')
        .limit(50)
        .get()
      applications = res.data.map(a => ({
        _id: a._id,
        applicantUid: a.applicant_uid,
        nickname: a.applicant_nickname || '医同学',
        credit: a.applicant_credit == null ? 100 : a.applicant_credit,
        completed: a.applicant_completed || 0,
        message: a.message,
        status: a.status
      }))
    } else if (user) {
      const res = await db.collection('applications')
        .where({ dealing_id: dealingId, applicant_uid: user._id })
        .get()
      applications = res.data.map(a => ({
        _id: a._id,
        applicantUid: a.applicant_uid,
        nickname: a.applicant_nickname || '我',
        credit: a.applicant_credit == null ? 100 : a.applicant_credit,
        completed: a.applicant_completed || 0,
        message: a.message,
        status: a.status
      }))
    }

    return {
      dealing: {
        _id: dealing._id,
        type: dealing.type,
        category: dealing.category,
        title: dealing.title,
        detail: dealing.detail,
        schedule: dealing.schedule,
        fee: dealing.fee,
        status: dealing.status,
        ownerUid: dealing.owner_uid,
        ownerNickname: dealing.owner_nickname || '',
        acceptedNickname: dealing.accepted_nickname || '',
        hospitalName: dealing.hospital_name || '',
        createdAt: dealing.created_at
      },
      isOwner,
      crossHospital,
      applications: isOwner ? applications : [],
      myApplication: !isOwner && applications.length ? applications[0] : null
    }
  }

  // ── 我的发布/我申请的 ──
  if (action === 'mine') {
    const user = await getUser()
    if (!user) return { ok: false, message: '请先登录' }
    const { role } = event // owner | applicant
    if (role === 'applicant') {
      const res = await db.collection('applications')
        .where({ applicant_uid: user._id })
        .orderBy('created_at', 'desc')
        .limit(50)
        .get()
      const ids = res.data.map(a => a.dealing_id)
      const dealings = ids.length
        ? (await db.collection('dealings').where({ _id: _.in(ids) }).get()).data
        : []
      const dmap = {}
      dealings.forEach(x => { dmap[x._id] = x })
      return {
        list: res.data.filter(a => dmap[a.dealing_id]).map(a => {
          const d = dmap[a.dealing_id]
          return {
            _id: d._id, title: d.title, category: d.category, status: d.status,
            fee: d.fee, schedule: d.schedule,
            applicationStatus: a.status, applicationId: a._id
          }
        })
      }
    }
    const res = await db.collection('dealings')
      .where({ owner_uid: user._id })
      .orderBy('created_at', 'desc')
      .limit(50)
      .get()
    return {
      list: res.data.map(d => ({
        _id: d._id, title: d.title, category: d.category, status: d.status,
        fee: d.fee, schedule: d.schedule
      }))
    }
  }

  // ── 创建：必须已认证，hospital_id 只取用户档案，不信请求参数 ──
  if (action === 'create') {
    const user = await getUser()
    if (!user) return { ok: false, code: 'NO_USER', message: '请先登录' }
    if (user.verify_status !== 'verified' || !user.hospital_id) {
      return { ok: false, code: 'NOT_VERIFIED', message: '请先完成医院认证' }
    }

    const { type, category, title, detail, schedule, fee } = event
    if (!ALLOWED_TYPES.includes(type)) return { ok: false, message: '非法类型' }
    if (!ALLOWED_CATEGORIES.includes(category)) return { ok: false, message: '非法类目' }
    if (!title || !String(title).trim()) return { ok: false, message: '标题不能为空' }
    if (type === 'requirement' && (!schedule || !String(schedule).trim())) {
      return { ok: false, message: '需求单必须填写时段' }
    }
    if (fee != null && (!Number.isFinite(Number(fee)) || Number(fee) < 0 || Number(fee) > 100000)) {
      return { ok: false, message: '酬金格式非法' }
    }

    // TODO(M2): 接入 msgSecCheck 对 title/detail 做内容安全校验，先审后发

    const now = new Date()
    const added = await db.collection('dealings').add({
      data: {
        type,
        category,
        hospital_id: user.hospital_id, // 服务端注入，拒绝前端指定
        owner_uid: user._id,
        owner_nickname: user.nickname || '',
        title: String(title).trim().slice(0, 30),
        detail: String(detail || '').trim().slice(0, 500),
        schedule: String(schedule || '').trim().slice(0, 40),
        fee: fee == null ? null : Number(fee),
        status: 'published',
        accepted_uid: null,
        accept_deadline: null,
        created_at: now,
        updated_at: now
      }
    })
    await db.collection('users').doc(user._id).update({
      data: { 'stats.published': db.command.inc(1), updated_at: now }
    })
    return { ok: true, dealingId: added._id }
  }

  return { ok: false, message: '未知 action' }
}
