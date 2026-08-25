const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

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
