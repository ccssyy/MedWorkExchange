const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const action = event.action || 'list'

  if (action === 'list') {
    // 返回省 → 市 → 医院树；Pilot 只开放长春 3 家吉大
    const res = await db.collection('hospitals')
      .where({ status: 'active' })
      .orderBy('province', 'asc')
      .orderBy('city', 'asc')
      .orderBy('name', 'asc')
      .limit(100)
      .get()
    return { hospitals: res.data.map(h => ({ _id: h._id, province: h.province, city: h.city, name: h.name })) }
  }

  if (action === 'get') {
    const { hospitalId } = event
    if (!hospitalId) return { ok: false, message: '缺少 hospitalId' }
    const res = await db.collection('hospitals').doc(hospitalId).get()
    return { hospital: { _id: res.data._id, province: res.data.province, city: res.data.city, name: res.data.name } }
  }

  return { ok: false, message: '未知 action' }
}
