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
  'conversations', 'messages', 'reviews', 'reports',
  'posts', 'comments', 'post_likes', 'ads', 'configs', 'audit_logs'
]

const pilotHospitals = [
  { province: '吉林省', city: '长春市', name: '吉林大学第一医院', aliases: ['吉大一院', '吉大第一医院', '吉林大学第一临床医学院'], status: 'active' },
  { province: '吉林省', city: '长春市', name: '吉林大学第二医院', aliases: ['吉大二院', '吉大第二医院'], status: 'active' },
  { province: '吉林省', city: '长春市', name: '吉林大学中日联谊医院', aliases: ['中日联谊医院', '吉大三院', '吉大中日联谊'], status: 'active' }
]

// 标准科室字典（一级科室 + 常见亚专科，picker 用）
const departments = [
  '内科', '外科', '妇产科', '儿科', '急诊科', '重症医学科', '麻醉科',
  '心内科', '呼吸内科', '消化内科', '神经内科', '肾内科', '内分泌科',
  '骨科', '神经外科', '心胸外科', '泌尿外科', '普外科',
  '精神科', '皮肤科', '眼科', '耳鼻喉科', '口腔科', '放射科', '超声科', '检验科', '病理科',
  '肿瘤科', '康复科', '全科', '其他'
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
      // 已存在则补别名（幂等升级）
      await db.collection('hospitals').where({ name: h.name }).update({
        data: { aliases: h.aliases }
      })
      console.log('hospital aliases updated:', h.name)
    }
  }

  // 科室字典写入 configs（dept-picker 数据源）
  const deptCfg = await db.collection('configs').where({ key: 'departments' }).count()
  if (deptCfg.total === 0) {
    await db.collection('configs').add({
      data: { key: 'departments', value: departments, updated_at: new Date() }
    })
    console.log('seeded departments dictionary')
  }

  // 复合索引需在控制台手动创建（索引管理），路径：
  //   dealings → [hospital_id(升序), status(升序), created_at(降序)]
  //   dealings → [city(升序), category(升序), created_at(降序)]（v1.1 筛选）
  //   conversations → [last_time(降序)]
  //   messages → [conversation_id(升序), created_at(升序)]
  //   posts → [status(升序), created_at(降序)] + [topic(升序), status(升序), created_at(降序)]
  //   comments → [post_id(升序), created_at(升序)]
  //   post_likes → 唯一索引 [post_id(升序), uid(升序)]
  //   audit_logs → [openid(升序), created_at(降序)]
  console.log('done. 请在控制台索引管理中补充上述复合索引。')
}

main()
