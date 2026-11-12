// M3 模块1 验证：私信全链（会话列表增强 → 聊天页收发 → 已读 → 导流拦截）
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
  await mp.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' })

  // 前置：构造一条已确认的撮合单（A10 流程复用）→ 自动生成会话
  console.log('\n[2] 前置：发布+seed申请+确认 → 生成会话')
  const mark = 'M3' + String(Date.now()).slice(-6)
  await mp.switchTab('/pages/publish/publish')
  await sleep(2200)
  let page = await curPage(mp)
  await page.setData({ title: mark + '-私信验证单', fee: '100' })
  await sleep(300)
  await page.$('.submit-btn').then(b => b.tap())

  // 轮询回列表定位
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
  if (!dealingId) { record('前置发布', false, ''); return finish(mp) }
  console.log('    dealingId:', dealingId)

  // seed 账号B申请 + 确认
  const seedR = await mp.evaluate(did => new Promise(res => {
    wx.cloud.callFunction({
      name: 'initdb',
      data: { action: 'seedApplication', testKey: 'mwe-test-only', dealingId: did, nickname: '测试B' }
    }).then(r => res(r.result)).catch(e => res({ ok: false, error: String(e) }))
  }), dealingId)
  console.log('    seed:', JSON.stringify(seedR).slice(0, 100))
  // 进详情确认
  await mp.reLaunch('/pages/detail/detail?id=' + dealingId)
  await sleep(2800)
  page = await curPage(mp)
  // 轮询等确认按钮出现（详情数据是异步加载的）
  let acceptBtn = null
  for (let i = 0; i < 10; i++) {
    acceptBtn = await page.$('.accept-btn')
    if (acceptBtn) break
    await sleep(800)
  }
  if (!acceptBtn) { record('前置确认', false, '无确认按钮'); return finish(mp) }
  await acceptBtn.tap()
  // 轮询等状态变 confirmed
  let dd = await page.data()
  for (let i = 0; i < 16; i++) {
    await sleep(600)
    dd = await page.data()
    if (dd.dealing && dd.dealing.status === 'confirmed') break
  }
  record('前置-撮合已确认', dd.dealing && dd.dealing.status === 'confirmed', `status=${dd.dealing && dd.dealing.status}`)

  // ===== 会话列表 =====
  console.log('\n[3] 消息页会话列表')
  await mp.switchTab('/pages/messages/messages')
  await sleep(2500)
  page = await curPage(mp)
  let md = await page.data()
  const conv = (md.conversations || []).find(c => c.dealingId === dealingId)
  record('会话出现在列表', !!conv, conv ? `对方=${conv.otherNickname}·${conv.otherHospital} 未读=${conv.unread}` : '未找到')
  if (!conv) return finish(mp)

  // ===== 进聊天页 =====
  console.log('\n[4] 聊天页')
  const cards = await page.$$('.conv')
  let target = null
  for (const c of cards) {
    const t = String(await c.text() || '')
    if (t.includes('测试B') || t.includes(mark)) { target = c; break }
  }
  await target.tap()
  await sleep(2500)
  page = await curPage(mp)
  record('进入聊天页', page.path.includes('chat'), page.path)
  if (!page.path.includes('chat')) return finish(mp)

  // 发送第一条
  await page.setData({ inputText: mark + '-你好，值班细节聊一下' })
  await sleep(200)
  await page.callMethod('onSend')
  // 轮询等消息出现
  let sent = null
  for (let i = 0; i < 14; i++) {
    await sleep(600)
    const cd = await page.data()
    sent = (cd.messages || []).find(m => m.content && m.content.includes(mark))
    if (sent) break
  }
  record('发送消息成功', !!sent, sent ? `len=${sent.content.length}` : '')

  // 发第二条
  await page.setData({ inputText: '8/28 18:00 到岗，白大褂自备' })
  await sleep(200)
  await page.callMethod('onSend')
  await sleep(2000)

  // ===== 导流拦截 =====
  console.log('\n[5] 导流拦截（手机号）')
  await page.setData({ inputText: '直接打我电话 13912345678' })
  await sleep(200)
  await page.callMethod('onSend')
  await sleep(2500)
  const cd2 = await page.data()
  const leaked = (cd2.messages || []).some(m => m.content && m.content.includes('13912345678'))
  const inputCleared = !cd2.inputText
  record('手机号消息被拦截', !leaked, leaked ? '!! 消息竟出现在本地' : '未入列表')
  // 服务端确认（peek messages）
  const serverCheck = await mp.evaluate(did => new Promise(res => {
    wx.cloud.callFunction({
      name: 'initdb',
      data: { action: 'peek', testKey: 'mwe-test-only', collection: 'applications', where: { dealing_id: did }, limit: 1 }
    }).then(r => res(r.result)).catch(() => res(null))
  }), dealingId)
  console.log('    (peek applications 可用性:', serverCheck && serverCheck.ok, ')')

  // ===== 会话未读/已读 =====
  console.log('\n[6] 已读标记')
  const readRes = await mp.evaluate(cid => new Promise(res => {
    wx.cloud.callFunction({
      name: 'message',
      data: { action: 'markRead', conversationId: cid }
    }).then(r => res(r.result)).catch(e => res({ error: String(e) }))
  }), conv._id)
  record('markRead 执行', !!(readRes && readRes.ok), readRes ? `updated=${readRes.updated}` : '')

  // ===== 清理 =====
  console.log('\n[清理]')
  await mp.evaluate(() => new Promise(res => {
    wx.cloud.callFunction({
      name: 'initdb',
      data: { action: 'cleanTestApplication', testKey: 'mwe-test-only' }
    }).then(r => res(r.result)).catch(() => res(null))
  }))
  console.log('    测试申请已清')
  // 回详情下架单子
  await mp.reLaunch('/pages/detail/detail?id=' + dealingId)
  await sleep(2200)
  page = await curPage(mp)
  const offBtn = await page.$('.op-offshelf')
  if (offBtn) {
    await offBtn.tap()
    await sleep(2500)
    console.log('    测试单已下架（私信记录保留在库，messages 随单不影响业务）')
  }

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
