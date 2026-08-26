const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

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

exports.main = async () => {
  const logs = []

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
