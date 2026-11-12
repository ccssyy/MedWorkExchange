// S3 回归：chat 举报对象指向对方（T7——otherUid 曾错取 _id 导致 A 方举报指到自己）
// 前置：账号已 verified（发布需认证）。链路复用 m3_chat：发布→seed→确认→会话→聊天页
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
async function callFn(mp, name, data) {
  return mp.evaluate((n, d) => new Promise(res => {
    wx.cloud.callFunction({ name: n, data: d }).then(r => res(r.result)).catch(e => res({ __err: e.errMsg || String(e) }))
  }), name, data)
}

async function main() {
  console.log('[1] 连接 automator ...')
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  await mp.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' })

  // ===== 前置：发布+seed申请+确认 → 会话（复用 m3_chat 链路）=====
  console.log('\n[2] 前置：发布+seed申请+确认')
  const mark = 'T7' + String(Date.now()).slice(-6)
  await mp.switchTab('/pages/publish/publish')
  await sleep(2200)
  let page = await curPage(mp)
  await page.setData({ title: mark + '-举报对象单', fee: '100' })
  await sleep(300)
  await page.$('.submit-btn').then(b => b.tap())

  let dealingId = null
  for (let i = 0; i < 16; i++) {
    await sleep(900)
    page = await curPage(mp)
    if (page.path.includes('publish')) continue
    const d = await page.data()
    const mine = (d.dealings || []).find(x => x.title && String(x.title).includes(mark))
    if (mine) { dealingId = mine._id; break }
    try { await page.callMethod('loadDealings') } catch (e) {}
  }
  record('前置发布', !!dealingId, dealingId || '未找到')
  if (!dealingId) return finish(mp)

  const seedR = await callFn(mp, 'initdb', { action: 'seedApplication', testKey: 'mwe-test-only', dealingId, nickname: '测试B' })
  record('seed 账号B申请', !!(seedR && seedR.ok), seedR ? String(seedR.applicationId || '').slice(0, 20) : JSON.stringify(seedR).slice(0, 60))

  await mp.reLaunch('/pages/detail/detail?id=' + dealingId)
  await sleep(2800)
  page = await curPage(mp)
  let acceptBtn = null
  for (let i = 0; i < 10; i++) {
    acceptBtn = await page.$('.accept-btn')
    if (acceptBtn) break
    await sleep(800)
  }
  if (!acceptBtn) { record('前置确认', false, '无确认按钮'); return finish(mp) }
  await acceptBtn.tap()
  let dd = await page.data()
  for (let i = 0; i < 16; i++) {
    await sleep(600)
    dd = await page.data()
    if (dd.dealing && dd.dealing.status === 'confirmed') break
  }
  record('前置-撮合已确认', dd.dealing && dd.dealing.status === 'confirmed', `status=${dd.dealing && dd.dealing.status}`)

  // ===== 进入聊天页 =====
  await mp.switchTab('/pages/messages/messages')
  await sleep(2500)
  page = await curPage(mp)
  const cards = await page.$$('.conv')
  let target = null
  for (const c of cards) {
    const t = String(await c.text() || '')
    if (t.includes('测试B') || t.includes(mark)) { target = c; break }
  }
  record('会话出现在列表', !!target, target ? '命中' : '未找到')
  if (!target) return finish(mp)
  await target.tap()
  await sleep(2500)
  page = await curPage(mp)
  record('进入聊天页', page.path.includes('chat'), page.path)
  if (!page.path.includes('chat')) return finish(mp)

  // ===== T7 核心断言：otherUid 指向对方（TEST_USER_B）而非自己 =====
  console.log('\n[3] T7 举报对象断言')
  const cd = await page.data()
  const me = await mp.evaluate(() => {
    const u = getApp().globalData.userInfo
    return u ? u.uid : ''
  })
  record('otherUid=对方(TEST_USER_B) 而非自己', cd.otherUid === 'TEST_USER_B' && cd.otherUid !== me,
    `otherUid=${cd.otherUid} me=${me}`)

  // 接口级佐证：以计算出的 otherUid 调 loadTarget（TEST_USER_B 无 users 记录 → 应返回"不存在"而非"不能举报自己"）
  const rep = await callFn(mp, 'report', { action: 'submit', targetType: 'user', targetId: cd.otherUid, reason: 'other' })
  record('举报提交指向对方（非 self 拦截）', !!(rep && rep.message && rep.message.indexOf('不能举报自己') < 0),
    rep ? rep.message || JSON.stringify(rep).slice(0, 50) : 'no resp')

  // ===== 清理 =====
  console.log('\n[清理]')
  await callFn(mp, 'initdb', { action: 'cleanTestApplication', testKey: 'mwe-test-only' })
  await mp.reLaunch('/pages/detail/detail?id=' + dealingId)
  await sleep(2200)
  page = await curPage(mp)
  const offBtn = await page.$('.op-offshelf')
  if (offBtn) { await offBtn.tap(); await sleep(2500); console.log('    测试单已下架') }

  await finish(mp)

  async function finish(mpi) {
    console.log('\n=== 汇总 ===')
    let fail = 0
    for (const r of results) {
      if (!r.ok) fail++
      console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name}${r.note ? ' | ' + r.note : ''}`)
    }
    console.log(fail === 0 ? '\n全部通过 ✓' : `\n${fail} 项失败`)
    await mpi.disconnect()
    process.exit(fail === 0 ? 0 : 1)
  }
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
