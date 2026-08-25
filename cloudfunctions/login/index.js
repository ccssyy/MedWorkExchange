const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const users = db.collection('users')
  const action = event.action || 'ensure'

  if (action === 'profile') {
    const found = await users.where({ openid: OPENID }).get()
    if (!found.data.length) return { user: null }
    return { user: maskUser(found.data[0]) }
  }

  if (action === 'ensure') {
    const found = await users.where({ openid: OPENID }).get()
    if (found.data.length) {
      return { user: maskUser(found.data[0]) }
    }
    const now = new Date()
    const created = await users.add({
      data: {
        openid: OPENID,
        nickname: '',
        avatar: '',
        phone: '',
        role: 'student',
        hospital_id: null,
        hospitalName: '',
        verify_status: 'none',
        verify_material: null,
        credit_score: 100,
        stats: { published: 0, accepted: 0, completed: 0 },
        created_at: now,
        updated_at: now
      }
    })
    return { uid: created._id, created: true }
  }

  return { ok: false, message: '未知 action' }
}

function maskUser(u) {
  return {
    uid: u._id,
    nickname: u.nickname,
    avatar: u.avatar,
    role: u.role,
    hospitalId: u.hospital_id,
    hospitalName: u.hospitalName,
    verifyStatus: u.verify_status || 'none',
    creditScore: u.credit_score == null ? 100 : u.credit_score,
    stats: u.stats || { published: 0, accepted: 0, completed: 0 }
  }
}
