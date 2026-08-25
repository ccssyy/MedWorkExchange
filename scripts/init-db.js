/**
 * 数据库初始化脚本 —— 在微信开发者工具「云开发控制台 → 数据库」中执行
 *
 * 用法：将本文件内容粘贴到云开发控制台的脚本控制台（或用 @cloudbase/cli 执行）。
 * 幂等设计：集合存在则跳过，医院数据按名称去重。
 *
 * 创建内容：
 *   1. 集合：users / hospitals / dealings / applications / conversations / messages / reviews / reports
 *   2. 索引（dealings 复合索引：hospital_id+status+created_at）
 *   3. 预置医院：长春 3 家吉大医院
 */

const collections = [
  'users', 'hospitals', 'dealings', 'applications',
  'conversations', 'messages', 'reviews', 'reports'
]

const pilotHospitals = [
  { province: '吉林省', city: '长春市', name: '吉林大学第一医院', status: 'active' },
  { province: '吉林省', city: '长春市', name: '吉林大学第二医院', status: 'active' },
  { province: '吉林省', city: '长春市', name: '吉林大学中日联谊医院', status: 'active' }
]

async function main() {
  const db = cloud.database()

  for (const name of collections) {
    try {
      await db.createCollection(name)
      console.log('created collection:', name)
    } catch (e) {
      console.log('skip collection (exists?):', name)
    }
  }

  for (const h of pilotHospitals) {
    const exists = await db.collection('hospitals').where({ name: h.name }).count()
    if (exists.total === 0) {
      await db.collection('hospitals').add({ data: { ...h, created_at: new Date() } })
      console.log('seeded hospital:', h.name)
    } else {
      console.log('hospital exists:', h.name)
    }
  }

  // 复合索引需在控制台手动创建（索引管理），路径：
  //   dealings → 索引管理 → 添加复合索引 [hospital_id(升序), status(升序), created_at(降序)]
  //   conversations → [last_time(降序)]
  //   messages → [conversation_id(升序), created_at(升序)]
  console.log('done. 请在控制台索引管理中补充上述复合索引。')
}

main()
