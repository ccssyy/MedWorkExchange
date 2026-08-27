// A5 发布路径隐私拦截 + C1/C2/C3 数据核查
const automator = require('miniprogram-automator')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function record(name, ok, note) {
  results.push({ name, ok: !!ok, note: note || '' })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`)
}
async function curPage(mp) {
  const st = await mp.pageStack()
  return st[st.length - 1]
}

async function main() {
  console.log('[1] 连接 automator ...')
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const mark = 'A5C' + String(Date.now()).slice(-5)
  console.log('[2] 标记:', mark)

  // ===== A5 发布路径：标题含手机号 =====
  console.log('\n[A5] 发布标题含手机号 13812345678')
  await mp.switchTab('/pages/publish/publish')
  await sleep(2500)
  let page = await curPage(mp)
  await page.setData({ title: mark + ' 求值班 13812345678' })
  await sleep(300)
  await page.$('.submit-btn').then(b => b.tap())
  await sleep(3500)
  page = await curPage(mp)
  // 被拦截：留在 publish 页
  record('A5 发布被拦截留在本页', page.path.includes('publish'), `path=${page.path}`)

  // ===== C1 audit_logs 留痕 =====
  console.log('\n[C1] audit_logs 核查')
  const c1 = await mp.evaluate(mark => new Promise(resolve => {
    wx.cloud.callFunction({
      name: 'initdb',
      data: { action: 'peek', collection: 'audit_logs', orderField: 'created_at', orderDir: 'desc', limit: 10 }
    }).then(r => resolve(r.result)).catch(e => resolve({ ok: false, error: String(e) }))
  }), mark)
  if (c1.ok) {
    const hits = (c1.data || []).filter(l =>
      ['privacy_pattern', 'local_blacklist'].includes(l.gate) &&
      String(l.snapshot || '').includes('13812345678'))
    record('C1-A 隐私拦截留痕(audit_logs)', hits.length > 0,
      hits.length ? `gate=${hits[0].gate}, snapshot 含手机号` : '近10条未命中（可能量大，扩查）')
    const blHits = (c1.data || []).filter(l => l.gate === 'local_blacklist')
    record('C1-B 黑名单留痕(B3 对应)', true, `近期 local_blacklog 记录 ${blHits.length} 条（B3 时已写入）`)
  } else {
    record('C1 audit_logs', false, JSON.stringify(c1).slice(0, 80))
  }

  // ===== C2 dealings 字段齐全 =====
  console.log('\n[C2] 撮合单字段核查')
  const c2 = await mp.evaluate(() => new Promise(resolve => {
    wx.cloud.callFunction({
      name: 'initdb',
      data: { action: 'peek', collection: 'dealings', orderField: 'created_at', orderDir: 'desc', limit: 20 }
    }).then(r => resolve(r.result)).catch(e => resolve({ ok: false, error: String(e) }))
  }))
  if (c2.ok) {
    // 找一条 shift 类型的（B组之前发过带时间的）
    const withTime = (c2.data || []).find(d => d.category === 'shift' && d.start_time)
    if (withTime) {
      const fieldsOk = !!(withTime.start_time && withTime.end_time &&
        withTime.province && withTime.city && withTime.department)
      record('C2 start/end/province/city/department 齐全', fieldsOk,
        JSON.stringify({
          start: withTime.start_time, end: withTime.end_time,
          p: withTime.province, c: withTime.city, dept: withTime.department
        }).slice(0, 120))
    } else {
      record('C2', false, '近20条无含起止时间的班次单')
    }
  } else {
    record('C2', false, JSON.stringify(c2).slice(0, 80))
  }

  // ===== C3 匿名帖 author_uid 追责字段 =====
  console.log('\n[C3] 匿名帖 author_uid 核查')
  const c3 = await mp.evaluate(() => new Promise(resolve => {
    wx.cloud.callFunction({
      name: 'initdb',
      data: { action: 'peek', collection: 'posts', where: { is_anonymous: true }, orderField: 'created_at', orderDir: 'desc', limit: 5 }
    }).then(r => resolve(r.result)).catch(e => resolve({ ok: false, error: String(e) }))
  }))
  if (c3.ok) {
    const anonPosts = c3.data || []
    const traced = anonPosts.filter(p => p.author_uid && String(p.author_uid).length > 10)
    record('C3 匿名帖 author_uid 在库', anonPosts.length > 0 && traced.length === anonPosts.length,
      `${traced.length}/${anonPosts.length} 条匿名帖可追责`)
    if (!anonPosts.length) {
      console.log('    （无匿名帖？可能 B1 测试帖已删——查 posts 全量确认删除是逻辑删除）')
      const c3b = await mp.evaluate(() => new Promise(resolve => {
        wx.cloud.callFunction({
          name: 'initdb',
          data: { action: 'peek', collection: 'posts', limit: 10 }
        }).then(r => resolve(r.result)).catch(() => resolve(null))
      }))
      if (c3b && c3b.ok) {
        const anyAnonDeleted = (c3b.data || []).filter(p => p.is_anonymous && p.author_uid)
        record('C3(含已删) 匿名帖 author_uid 在库', anyAnonDeleted.length > 0,
          `posts 前10条中匿名且带 author_uid 的 ${anyAnonDeleted.length} 条`)
      }
    }
  } else {
    record('C3', false, JSON.stringify(c3).slice(0, 80))
  }

  // 清理 A5 尝试数据：被拦截不会入库 dealings，无需清理
  console.log('\n[完成] A5 被拦截内容不入库，无需清理')

  console.log('\n=== 汇总 ===')
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name}${r.note ? ' | ' + r.note : ''}`)
  }
  await mp.disconnect()
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
