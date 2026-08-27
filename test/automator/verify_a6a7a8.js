// A6 筛选联动 / A7 关键词搜索 / A8 排序
// 先发布两条不同价格的"夜班"值班单，再验证筛选/搜索/排序
const automator = require('miniprogram-automator')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function record(name, ok, note) {
  results.push({ name, ok, note })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`)
}

async function publishOne(mp, title, fee) {
  await mp.switchTab('/pages/publish/publish')
  await sleep(2500)
  const st = await mp.pageStack()
  const pub = st[st.length - 1]
  // 直接 setData 更稳（input 双向绑定字段名：title / fee）
  await pub.setData({ title, fee: String(fee) })
  await sleep(300)
  const btn = await pub.$('.submit-btn')
  if (!btn) throw new Error('submit-btn 未找到，path=' + pub.path)
  await btn.tap()
  await sleep(3500)
  // 校验是否仍在发布页（若认证弹窗会跳 profile）
  const st2 = await mp.pageStack()
  const cur = st2[st2.length - 1]
  if (!cur.path.includes('publish')) {
    console.log('    ! 发布后未停留在 publish 页: ' + cur.path)
    await mp.switchTab('/pages/publish/publish')
    await sleep(1500)
  }
}

async function getCards(mp) {
  await mp.switchTab('/pages/index/index')
  await sleep(2200)
  const st = await mp.pageStack()
  const idx = st[st.length - 1]
  // 只取非 ad-slot 卡片：看文本是否含 ￥
  const cards = await idx.$$('.card')
  const out = []
  for (const c of cards) {
    const t = String(await c.text() || '')
    if (!t.includes('广告')) out.push(t)
  }
  return { cards: out, page: idx }
}

function extractFee(text) {
  const m = text.match(/￥\s*(\d+)/)
  return m ? Number(m[1]) : null
}

async function main() {
  console.log('[1] 连接 automator ...')
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  console.log('    已连接 SDK:', (await mp.systemInfo()).SDKVersion)

  const mark = 'AU' + String(Date.now()).slice(-6)
  console.log('[2] 标记:', mark)

  console.log('\n[3] 发布两条测试单（值班 夜班，￥150 与 ￥250）')
  await publishOne(mp, mark + '夜班-甲', 150)
  await publishOne(mp, mark + '夜班-乙', 250)

  // ===== A6 筛选联动 =====
  console.log('\n[A6] 类别=值班 + 价格100-300')
  let { cards, page } = await getCards(mp)
  console.log('    发布后总数:', cards.length)
  await page.setData({ categoryIndex: 1, feeIndex: 3 }) // 值班 + ￥100-300
  await page.callMethod('loadDealings')
  await sleep(2500)

  let r2 = await getCards(mp)
  cards = r2.cards
  const a6AllShift = cards.every(t => t.includes('值班'))
  const a6FeeRange = cards.map(t => extractFee(t)).filter(f => f !== null)
  const a6InRange = a6FeeRange.length > 0 && a6FeeRange.every(f => f >= 100 && f <= 300)
  record('A6 全部为值班且价格100-300', a6AllShift && a6InRange,
    `${cards.length} 张卡, fees=${a6FeeRange.join(',')}`)

  // ===== A7 关键词搜索 =====
  console.log('\n[A7] 搜索"夜班"')
  const p7 = r2.page
  await p7.setData({ keyword: '夜班', categoryIndex: 0, feeIndex: 0 })
  await p7.callMethod('loadDealings')
  await sleep(2500)
  let r7 = await getCards(mp)
  const a7Titles = r7.cards.filter(t => t.includes(mark))
  record('A7 搜索命中两条夜班单', a7Titles.length >= 2,
    `含标记的卡片 ${a7Titles.length}/2`)

  // 负向：搜不存在的词应无结果
  await p7.setData({ keyword: 'ZZZ不存在的词QQQ' })
  await p7.callMethod('loadDealings')
  await sleep(2500)
  let r7b = await getCards(mp)
  const a7neg = r7b.cards.every(t => !t.includes(mark))
  record('A7-负向 无关词无结果', a7neg, `${r7b.cards.length} 张卡`)

  // ===== A8 排序 =====
  console.log('\n[A8] 价格低到高 / 高到低')
  const p8 = r7b.page
  await p8.setData({ keyword: mark, sortIndex: 0 })
  await p8.callMethod('loadDealings')
  await sleep(2500)
  let base = await getCards(mp)
  const p8r = base.page

  await p8r.setData({ sortIndex: 1 }) // 价格低到高
  await p8r.callMethod('loadDealings')
  await sleep(2500)
  let asc = await getCards(mp)
  const ascFees = asc.cards.filter(t => t.includes(mark)).map(extractFee).filter(f => f !== null)

  await p8r.setData({ sortIndex: 2 }) // 价格高到低
  await p8r.callMethod('loadDealings')
  await sleep(2500)
  let desc = await getCards(mp)
  const descFees = desc.cards.filter(t => t.includes(mark)).map(extractFee).filter(f => f !== null)

  const a8ascOk = ascFees.length === 2 && ascFees[0] <= ascFees[1] && ascFees[0] === 150
  const a8descOk = descFees.length === 2 && descFees[0] >= descFees[1] && descFees[0] === 250
  record('A8 低到高 [150,250]', a8ascOk, JSON.stringify(ascFees))
  record('A8 高到低 [250,150]', a8descOk, JSON.stringify(descFees))

  // ===== 清理：下架两条测试单 =====
  console.log('\n[清理] 下架两条测试单')
  await mp.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' })
  for (const name of ['甲', '乙']) {
    const st = await mp.pageStack()
    let cur = st[st.length - 1]
    if (!cur.path.includes('index')) {
      await mp.switchTab('/pages/index/index')
      await sleep(2000)
    }
    const s2 = await mp.pageStack()
    const idxPage = s2[s2.length - 1]
    const cardsNow = await idxPage.$$('.card')
    let target = null
    for (const c of cardsNow) {
      const t = String(await c.text() || '')
      if (t.includes(mark + '夜班-' + name)) { target = c; break }
    }
    if (!target) { console.log(`    ${name}: 未找到（可能已下架）`); continue }
    await target.tap()
    await sleep(2200)
    const s3 = await mp.pageStack()
    const det = s3[s3.length - 1]
    const offBtn = await det.$('.op-offshelf')
    if (!offBtn) { console.log(`    ${name}: 无下架按钮`); await mp.navigateBack(); await sleep(1200); continue }
    await offBtn.tap()
    await sleep(3000)
    await mp.switchTab('/pages/index/index')
    await sleep(1800)
    console.log(`    ${name} 已下架`)
  }

  console.log('\n=== 汇总 ===')
  let fail = 0
  for (const r of results) {
    if (!r.ok) fail++
    console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name}${r.note ? ' | ' + r.note : ''}`)
  }
  console.log(fail === 0 ? '\n全部通过 ✓' : `\n${fail} 项失败`)
  await mp.disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
