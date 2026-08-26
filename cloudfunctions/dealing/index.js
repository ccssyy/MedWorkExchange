const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ALLOWED_CATEGORIES = ['shift', 'case_guide']
const ALLOWED_TYPES = ['requirement', 'service']
const ALLOWED_SORTS = ['latest', 'fee_asc', 'fee_desc', 'time_near']

// 内容安全：本地黑名单 + 患者隐私正则（与 posts 云函数同源）
const LOCAL_BLACKLIST = [
  '法轮功', '赌博', '代开发票', '毒品', '冰毒', '枪支', '买微信号',
  '加微信', '加V', '微信号', '转账到', '刷单', '代办证书'
]
const PRIVACY_PATTERNS = [
  /\d{17}[\dXx]/,
  /1[3-9]\d{9}/
]

async function secCheckText(openid, content) {
  const text = String(content || '')
  for (const w of LOCAL_BLACKLIST) {
    if (text.includes(w)) {
      await db.collection('audit_logs').add({
        data: { openid, gate: 'local_blacklist', snapshot: text.slice(0, 200), created_at: new Date() }
      }).catch(() => {})
      return { ok: false, code: 'RISK_CONTENT', message: `内容含违规词，请修改` }
    }
  }
  for (const p of PRIVACY_PATTERNS) {
    if (p.test(text.replace(/[\s-]/g, ''))) {
      await db.collection('audit_logs').add({
        data: { openid, gate: 'privacy_pattern', snapshot: text.slice(0, 200), created_at: new Date() }
      }).catch(() => {})
      return { ok: false, code: 'RISK_PRIVACY', message: '疑似患者隐私信息（身份证/手机号），请脱敏后发布' }
    }
  }
  try {
    await cloud.openapi.security.msgSecCheck({
      openid, scene: 2, version: 2, content: text
    })
    return { ok: true }
  } catch (e) {
    if (e.errCode === 87014) {
      await db.collection('audit_logs').add({
        data: { openid, gate: 'msgSecCheck', snapshot: text.slice(0, 200), created_at: new Date() }
      }).catch(() => {})
      return { ok: false, code: 'RISK_CONTENT', message: '内容含违规信息，请修改后重试' }
    }
    console.error('msgSecCheck error', e)
    return { ok: false, code: 'SEC_CHECK_FAIL', message: '系统繁忙，请稍后重试' }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'

  // 当前用户档案（写操作与身份校验的依据）
  async function getUser() {
    const found = await db.collection('users').where({ openid: OPENID }).get()
    return found.data[0] || null
  }

  // ── 列表：多维筛选（D12）——keyword/category/department/time/fee/hospital/province/city/sort ──
  if (action === 'list') {
    const {
      keyword, category, department, type, status,
      timeFrom, timeTo, feeMin, feeMax,
      hospitalId, province, city, sort
    } = event
    const where = { status: _.neq('cancelled') }
    if (hospitalId) where.hospital_id = hospitalId
    if (province) where.province = province
    if (city) where.city = city
    if (category && ALLOWED_CATEGORIES.includes(category)) where.category = category
    if (department) where.department = department
    if (type && ALLOWED_TYPES.includes(type)) where.type = type
    if (status) where.status = status
    if (timeFrom || timeTo) {
      where.start_time = {}
      if (timeFrom) where.start_time = _.gte(new Date(timeFrom))
      if (timeTo) where.start_time = timeFrom ? _.and(_.gte(new Date(timeFrom)), _.lte(new Date(timeTo))) : _.lte(new Date(timeTo))
    }
    if (feeMin != null || feeMax != null) {
      where.fee = {}
      if (feeMin != null && feeMax != null) where.fee = _.and(_.gte(Number(feeMin)), _.lte(Number(feeMax)))
      else if (feeMin != null) where.fee = _.gte(Number(feeMin))
      else where.fee = _.lte(Number(feeMax))
    }

    let orderBy = 'created_at', orderDir = 'desc'
    if (sort === 'fee_asc') { orderBy = 'fee'; orderDir = 'asc' }
    if (sort === 'fee_desc') { orderBy = 'fee'; orderDir = 'desc' }
    if (sort === 'time_near') { orderBy = 'start_time'; orderDir = 'asc' }

    // 组装最终查询（keyword 与其他条件 AND + 多字段 OR）
    const hasKeyword = keyword && String(keyword).trim()
    let query
    if (hasKeyword) {
      const safe = String(keyword).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const reg = db.RegExp({ regexp: safe, options: 'i' })
      query = db.collection('dealings').where(_.and([
        where,
        _.or([{ title: reg }, { detail: reg }, { hospital_name: reg }, { department: reg }])
      ]))
    } else {
      query = db.collection('dealings').where(where)
    }
    const res = await query.orderBy(orderBy, orderDir).limit(50).get()
    return {
      dealings: res.data.map(d => ({
        _id: d._id,
        type: d.type,
        category: d.category,
        title: d.title,
        detail: d.detail,
        schedule: d.schedule,
        startTime: d.start_time,
        endTime: d.end_time,
        fee: d.fee,
        status: d.status,
        department: d.department,
        hospitalName: d.hospital_name,
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

  // ── 创建：必须已认证，hospital_id 只取用户档案，不信请求参数（D9 极简发布）──
  if (action === 'create') {
    const user = await getUser()
    if (!user) return { ok: false, code: 'NO_USER', message: '请先登录' }
    if (user.verify_status !== 'verified' || !user.hospital_id) {
      return { ok: false, code: 'NOT_VERIFIED', message: '请先完成医院认证' }
    }

    const { type, category, title, detail, fee, startTime, endTime } = event
    if (!ALLOWED_TYPES.includes(type)) return { ok: false, message: '非法类型' }
    if (!ALLOWED_CATEGORIES.includes(category)) return { ok: false, message: '非法类目' }
    if (!title || !String(title).trim()) return { ok: false, message: '标题不能为空' }
    if (fee != null && (!Number.isFinite(Number(fee)) || Number(fee) < 0 || Number(fee) > 100000)) {
      return { ok: false, message: '酬金格式非法' }
    }
    // 起止时间：值班需求必填且 start < end；病例指导可不填
    let startT = null, endT = null
    if (startTime) {
      startT = new Date(startTime)
      if (isNaN(startT.getTime())) return { ok: false, message: '开始时间格式非法' }
    }
    if (endTime) {
      endT = new Date(endTime)
      if (isNaN(endT.getTime())) return { ok: false, message: '结束时间格式非法' }
    }
    if (category === 'shift' && (!startT || !endT)) {
      return { ok: false, message: '值班需求必须选择起止时间' }
    }
    if (startT && endT && endT <= startT) {
      return { ok: false, message: '结束时间必须晚于开始时间' }
    }

    // 内容安全三级管线：本地黑名单 → 隐私正则 → msgSecCheck
    const secResult = await secCheckText(OPENID, `${title}\n${detail || ''}`)
    if (!secResult.ok) return secResult

    const now = new Date()
    const added = await db.collection('dealings').add({
      data: {
        type,
        category,
        hospital_id: user.hospital_id,   // 服务端注入，拒绝前端指定
        hospital_name: user.hospitalName || '',
        province: user.province || '',
        city: user.city || '',
        department: user.department || '',
        owner_uid: user._id,
        owner_nickname: user.nickname || '',
        title: String(title).trim().slice(0, 30),
        detail: String(detail || '').trim().slice(0, 500),
        start_time: startT,
        end_time: endT,
        schedule: startT && endT ? formatRange(startT, endT) : '',
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

function formatRange(s, e) {
  const pad = n => String(n).padStart(2, '0')
  const f = d => `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${f(s)}-${f(e)}`
}
