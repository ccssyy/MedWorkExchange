// B4 + B6 复测：修正话题索引（post-publish 页无"全部"，index1=病例讨论）、加长点赞等待
const automator = require('miniprogram-automator')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function record(name, ok, note) {
  results.push({ name, ok, note })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`)
}
async function curPage(mp) {
  const st = await mp.pageStack()
  return st[st.length - 1]
}

async function main() {
  console.log('[1] 连接 automator ...')
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const mark = 'BP' + String(Date.now()).slice(-6)
  console.log('[2] 标记:', mark)

  // ===== B4 复测 =====
  console.log('\n[B4] 病例话题脱敏提示（正确索引）')
  await mp.switchTab('/pages/board/board')
  await sleep(1800)
  let page = await curPage(mp)
  const composeBtn = await page.$('.compose-btn')
  await composeBtn.tap()
  await sleep(2000)
  page = await curPage(mp)
  const noTipBefore = !(await page.$('.privacy-tip'))
  const pills = await page.$$('.topic-pill')
  console.log('    发帖页话题数:', pills.length)
  await pills[1].tap() // index1 = 病例讨论
  await sleep(800)
  const tipEl = await page.$('.privacy-tip')
  const tipText = tipEl ? String(await tipEl.text() || '') : ''
  record('B4 切病例讨论出红条', noTipBefore && !!tipEl && tipText.includes('脱敏'),
    tipText.trim().slice(0, 32))

  // 继续用此页发一帖供 B6 测试（病例讨论话题）
  await page.setData({ title: mark + '-点赞测试', content: '点赞功能自动化验证帖。' })
  await sleep(300)
  const btn = await page.$('.submit-btn')
  await btn.tap()
  // 成功后 navigateBack 回留言板（发帖页不跳详情）
  await sleep(4000)
  page = await curPage(mp)
  if (!page.path.includes('board')) {
    record('B6 前置-回到列表', false, 'path=' + page.path)
    return finish(mp)
  }
  // 列表找到刚发的帖子进详情
  await sleep(1500)
  const cards6 = await page.$$('.card.post')
  let target6 = null
  for (const c of cards6) {
    const t = String(await c.text() || '')
    if (t.includes(mark)) { target6 = c; break }
  }
  if (!target6) { record('B6 前置-列表找到帖', false, `列表 ${cards6.length} 张卡`); return finish(mp) }
  await target6.tap()
  await sleep(2500)
  page = await curPage(mp)
  if (!page.path.includes('post-detail')) {
    record('B6 前置-进详情页', false, 'path=' + page.path)
    return finish(mp)
  }

  // ===== B6 复测 =====
  console.log('\n[B6] 点赞（长等待验证）')
  let d0 = await page.data()
  const like0 = d0.post.likeCount
  console.log('    初始 likeCount:', like0)

  await page.$('.like-btn').then(b => b.tap())
  // 轮询等数据变化，最多 8 秒
  let likedVal = null
  for (let i = 0; i < 16; i++) {
    await sleep(500)
    const dd = await page.data()
    likedVal = dd.post.likeCount
    if (likedVal !== like0) break
  }
  record('B6 点赞+1', likedVal === like0 + 1, `${like0} -> ${likedVal}`)

  await page.$('.like-btn').then(b => b.tap())
  let unlikedVal = null
  for (let i = 0; i < 16; i++) {
    await sleep(500)
    const dd = await page.data()
    unlikedVal = dd.post.likeCount
    if (unlikedVal !== likedVal) break
  }
  record('B6 取消复原', unlikedVal === like0, `${likedVal} -> ${unlikedVal}`)

  // 清理删除帖子
  console.log('\n[清理] 删除测试帖')
  await page.callMethod('onDeletePost')
  await sleep(2500)
  page = await curPage(mp)
  console.log('    回到:', page.path)

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
