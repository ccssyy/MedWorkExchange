const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const collections = [
  'users', 'hospitals', 'dealings', 'applications',
  'conversations', 'messages', 'reviews', 'reports',
  'posts', 'comments', 'post_likes', 'ads', 'configs', 'audit_logs'
]

const pilotHospitals = [
  { province: '吉林省', city: '长春市', name: '吉林大学第一医院', aliases: ['吉大一院', '吉大第一医院', '吉林大学第一临床医学院'], status: 'active' },
  { province: '吉林省', city: '长春市', name: '吉林大学第二医院', aliases: ['吉大二院', '吉大第二医院'], status: 'active' },
  { province: '吉林省', city: '长春市', name: '吉林大学中日联谊医院', aliases: ['中日联谊医院', '吉大三院', '吉大中日联谊'], status: 'active' }
]

const departments = [
  '内科', '外科', '妇产科', '儿科', '急诊科', '重症医学科', '麻醉科',
  '心内科', '呼吸内科', '消化内科', '神经内科', '肾内科', '内分泌科',
  '骨科', '神经外科', '心胸外科', '泌尿外科', '普外科',
  '精神科', '皮肤科', '眼科', '耳鼻喉科', '口腔科', '放射科', '超声科', '检验科', '病理科',
  '肿瘤科', '康复科', '全科', '其他'
]

// 运维/测试口令：只从云函数环境变量读取，仓库不落默认值。
// 未配置 TEST_KEY 的环境（生产）本函数所有调用一律拒绝，防测试后门被利用（交接计划 R1/T1）
const TEST_KEY = process.env.TEST_KEY || ''

exports.main = async (event = {}) => {
  const logs = []

  // ── 全函数口令校验：建库/seed/测试辅助都是运维动作，不对普通用户开放 ──
  if (!TEST_KEY || event.testKey !== TEST_KEY) {
    return { ok: false, code: 'FORBIDDEN', message: 'initdb requires TEST_KEY env var and matching testKey' }
  }

  // ── 测试辅助：设置/更新当前用户的测试字段（is_admin / credit_score / verify_status）──
  if (event.action === 'setTestUser') {
    const { OPENID } = cloud.getWXContext()
    const patch = {}
    if (typeof event.isAdmin === 'boolean') patch.is_admin = event.isAdmin
    if (event.creditScore != null) patch.credit_score = Number(event.creditScore)
    if (event.verifyStatus != null && ['none', 'pending', 'verified', 'rejected'].includes(event.verifyStatus)) {
      patch.verify_status = event.verifyStatus
    }
    // clearVerifyMaterial: 连材料、医院绑定一并清空（真正的"复位重走认证流"，而不只是改状态位）
    if (event.clearVerifyMaterial === true) {
      patch.verify_material = _.remove()
      patch.hospital_id = _.remove()
      patch.hospitalName = _.remove()
    }
    if (!Object.keys(patch).length) return { ok: false, message: 'no patch fields' }
    const r = await db.collection('users').where({ openid: OPENID })
      .update({ data: { ...patch, updated_at: new Date() } })
    return { ok: true, updated: (r.stats && r.stats.updated) || 0, patch }
  }

  // ── 测试辅助：构造/清理"账号B申请"（降级验证 A10/A12 用）──
  if (event.action === 'seedApplication') {
    const { dealingId, nickname, hospital, department, message } = event
    const d = await db.collection('dealings').doc(dealingId).get().catch(() => null)
    if (!d || !d.data) return { ok: false, message: '撮合单不存在' }
    const now = new Date()
    const add = await db.collection('applications').add({
      data: {
        dealing_id: dealingId,
        applicant_uid: 'TEST_USER_B',
        applicant_nickname: nickname || '测试B',
        applicant_hospital: hospital || '吉林大学第二医院',
        applicant_department: department || '呼吸内科',
        applicant_credit: 100,
        applicant_completed: 0,
        message: String(message || '').slice(0, 100),
        status: 'pending',
        created_at: now,
        updated_at: now
      }
    })
    await db.collection('dealings').doc(dealingId).update({
      data: { status: 'applied', updated_at: now }
    })
    return { ok: true, applicationId: add._id }
  }

  if (event.action === 'cleanTestApplication') {
    const r = await db.collection('applications')
      .where({ applicant_uid: 'TEST_USER_B' })
      .remove()
    return { ok: true, removed: (r.stats && r.stats.removed) || 0 }
  }

  // ── 测试辅助：读库核查（C 组用例，只读）──
  if (event.action === 'peek') {
    const { collection, where, orderField, orderDir, limit } = event
    const allowed = ['dealings', 'audit_logs', 'posts', 'applications', 'reviews', 'users', 'reports', 'messages']
    if (!allowed.includes(collection)) return { ok: false, message: 'collection not allowed' }
    let q = db.collection(collection)
    if (where) q = q.where(where)
    if (orderField) q = q.orderBy(orderField, orderDir === 'asc' ? 'asc' : 'desc')
    const res = await q.limit(Math.min(limit || 10, 50)).get()
    // users 只做敏感字段裁剪（openid/手机号/实名不出测试后门），其余字段留给脚本断言
    const data = collection === 'users'
      ? res.data.map(({ openid, phone, real_name, id_last4, ...safe }) => safe)
      : res.data
    return { ok: true, data }
  }

  for (const name of collections) {
    try {
      await db.createCollection(name)
      logs.push(`created: ${name}`)
    } catch (e) {
      logs.push(`skip(exists): ${name}`)
    }
  }

  for (const h of pilotHospitals) {
    const exists = await db.collection('hospitals').where({ name: h.name }).count()
    if (exists.total === 0) {
      await db.collection('hospitals').add({ data: { ...h, created_at: new Date() } })
      logs.push(`seeded hospital: ${h.name}`)
    } else {
      await db.collection('hospitals').where({ name: h.name }).update({ data: { aliases: h.aliases } })
      logs.push(`aliases updated: ${h.name}`)
    }
  }

  const deptCfg = await db.collection('configs').where({ key: 'departments' }).count()
  if (deptCfg.total === 0) {
    await db.collection('configs').add({
      data: { key: 'departments', value: departments, updated_at: new Date() }
    })
    logs.push('seeded departments dictionary')
  } else {
    logs.push('departments dictionary exists')
  }

  logs.push('DONE. 还需手动补索引: post_likes 唯一[post_id,uid] / posts[status,created_at] / comments[post_id,created_at] / dealings[city,category,created_at]')
  return { ok: true, logs }
}
