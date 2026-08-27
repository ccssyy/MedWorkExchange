const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const action = event.action || 'list'

  if (action === 'list') {
    const res = await db.collection('hospitals')
      .where({ status: 'active' })
      .orderBy('province', 'asc')
      .orderBy('city', 'asc')
      .orderBy('name', 'asc')
      .limit(100)
      .get()
    return { hospitals: res.data.map(maskHospital) }
  }

  // 模糊 + 别名搜索：'吉大一院' 可命中 '吉林大学第一医院'
  // 策略：name 正则模糊 或 aliases 数组包含关键词（别名精确/前缀命中）
  if (action === 'search') {
    const keyword = String(event.keyword || '').trim()
    if (!keyword) return { hospitals: [] }
    const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const reg = db.RegExp({ regexp: safeKeyword, options: 'i' })
    const res = await db.collection('hospitals')
      .where(db.command.or([
        { name: reg },
        { aliases: reg }
      ]))
      .limit(20)
      .get()
    return { hospitals: res.data.map(maskHospital) }
  }

  if (action === 'get') {
    const { hospitalId } = event
    if (!hospitalId) return { ok: false, message: '缺少 hospitalId' }
    const res = await db.collection('hospitals').doc(hospitalId).get()
    return { hospital: maskHospital(res.data) }
  }

  return { ok: false, message: '未知 action' }
}

function maskHospital(h) {
  return {
    _id: h._id,
    province: h.province,
    city: h.city,
    name: h.name,
    aliases: h.aliases || []
  }
}
