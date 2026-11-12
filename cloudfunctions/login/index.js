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
    await users.add({
      data: {
        openid: OPENID,
        nickname: '',
        avatar: '',
        phone: '',
        role: 'student',          // student=规培实习生 / doctor=正职医生
        hospital_id: null,
        hospitalName: '',
        province: '',
        city: '',
        department: '',           // 标准科室字典值（dept-picker）
        verify_status: 'none',
        verify_material: null,
        credit_score: 100,
        stats: { published: 0, accepted: 0, completed: 0 },
        created_at: now,
        updated_at: now
      }
    })
    return { created: true }
  }

  // 更新基础资料（昵称/科室/角色；医院归属变更需走认证审核）
  if (action === 'updateProfile') {
    const found = await users.where({ openid: OPENID }).get()
    if (!found.data.length) return { ok: false, message: '请先登录' }
    const user = found.data[0]
    const patch = {}
    if (event.nickname != null) patch.nickname = String(event.nickname).trim().slice(0, 20)
    if (event.department != null) patch.department = String(event.department).slice(0, 30)
    if (event.role != null && ['student', 'doctor'].includes(event.role)) patch.role = event.role
    if (!Object.keys(patch).length) return { ok: false, message: '无可更新字段' }
    patch.updated_at = new Date()
    await users.doc(user._id).update({ data: patch })
    return { ok: true }
  }

  // ── 患者端：手机号绑定（phoneCode 换手机号）──
  if (action === 'bindPatientPhone') {
    const found = await users.where({ openid: OPENID }).get()
    let user = found.data[0]
    if (!user) {
      // 首次进入：建档（未激活）
      await users.add({
        data: {
          openid: OPENID, nickname: '', avatar: '', phone: '', role: 'student',
          hospital_id: null, hospitalName: '', province: '', city: '', department: '',
          verify_status: 'none', verify_material: null, credit_score: 100,
          stats: { published: 0, accepted: 0, completed: 0 },
          created_at: new Date(), updated_at: new Date()
        }
      })
      const again = await users.where({ openid: OPENID }).get()
      user = again.data[0]
    }
    try {
      const phoneRes = await cloud.openapi.phonenumber.getPhoneNumber({ code: event.phoneCode })
      const phone = phoneRes.phoneInfo && phoneRes.phoneInfo.purePhoneNumber
      if (!phone) return { ok: false, message: '手机号获取失败' }
      await users.doc(user._id).update({
        data: { phone, updated_at: new Date() }
      })
      const masked = phone.slice(0, 3) + '****' + phone.slice(-4)
      return { ok: true, phoneMasked: masked }
    } catch (e) {
      console.error('getPhoneNumber error', e)
      return { ok: false, message: '手机号解密失败，请重试' }
    }
  }

  // ── 患者端：实名激活（role → patient）──
  if (action === 'activatePatient') {
    const found = await users.where({ openid: OPENID }).get()
    const user = found.data[0]
    if (!user) return { ok: false, message: '请先完成手机号验证' }
    if (user.role === 'patient') return { ok: true, user: maskUser(user) }
    const realName = String(event.realName || '').trim()
    const idLast4 = String(event.idLast4 || '').trim()
    if (!realName || !/^\d{4}$/.test(idLast4)) {
      return { ok: false, message: '实名信息不完整' }
    }
    await users.doc(user._id).update({
      data: {
        role: 'patient',
        real_name: realName.slice(0, 20),       // 追责留档，前端不下发
        id_last4: idLast4,
        nickname: user.nickname || realName.slice(0, 4),
        updated_at: new Date()
      }
    })
    const again = await users.where({ openid: OPENID }).get()
    return { ok: true, user: maskUser(again.data[0]) }
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
    province: u.province || '',
    city: u.city || '',
    department: u.department || '',
    verifyStatus: u.verify_status || 'none',
    phoneMasked: u.phone ? u.phone.slice(0, 3) + '****' + u.phone.slice(-4) : '',
    isPatient: u.role === 'patient',
    isAdmin: !!u.is_admin,
    creditScore: u.credit_score == null ? 100 : u.credit_score,
    stats: u.stats || { published: 0, accepted: 0, completed: 0 }
  }
}
