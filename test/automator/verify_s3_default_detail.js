// S3 回归：首页默认本院（T9/D8）+ 详情页无跨院拦截残留（Q8 回归）
// 前置：账号已认证且锚点医院存在（m5 类脚本跑完后即为 verified）
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

  // ===== 0. 刷新 globalData 档案（消除会话内陈旧状态）=====
  const prof = await callFn(mp, 'login', { action: 'profile' })
  const user = prof && prof.user
  record('前置：账号已认证且锚点医院存在', !!(user && user.verifyStatus === 'verified' && user.hospitalId),
    user ? `${user.verifyStatus} / ${user.hospitalName}` : '无档案')
  if (!user || user.verifyStatus !== 'verified' || !user.hospitalId) return finish(mp)
  await mp.evaluate(u => { getApp().globalData.userInfo = u }, user)

  // ===== 1. 首页默认本院 =====
  console.log('\n[2] 首页默认信息域（T9）')
  await mp.reLaunch('/pages/index/index')
  await sleep(2800)
  let page = await curPage(mp)
  let d = await page.data()
  record('默认标签=本院', d.browsingLabel === '本院', `label=${d.browsingLabel}`)
  const ownAll = (d.dealings || []).every(x => x.hospitalName === user.hospitalName)
  record('默认列表全为本院单', ownAll && d.dealings.length >= 0,
    ` ${d.dealings.length} 张 / 锚点=${user.hospitalName}`)

  // ===== 2. 抽屉切院（搜索→选院）=====
  const sr = await callFn(mp, 'hospital', { action: 'search', keyword: '吉林大学第一医院' })
  const target = ((sr && sr.hospitals) || []).find(h => h.name === '吉林大学第一医院')
  record('医院搜索命中吉大一院', !!target, target ? target._id : 'not found')
  if (!target) return finish(mp)
  await page.setData({ hospitalResults: [target] })
  await page.callMethod('onPickHospital', { currentTarget: { dataset: { index: 0 } } })
  await sleep(1800)
  d = await page.data()
  record('切院后标签=所选医院', d.browsingLabel === target.name, `label=${d.browsingLabel}`)
  const otherAll = (d.dealings || []).every(x => x.hospitalName === target.name)
  record('切院后列表全为所选医院单（可为空集）', otherAll, ` ${d.dealings.length} 张`)

  // ===== 3. 清除筛选 = 回默认本院 =====
  await page.callMethod('clearHospital')
  await sleep(1800)
  d = await page.data()
  record('清除后标签回本院', d.browsingLabel === '本院', `label=${d.browsingLabel} selected=${JSON.stringify(d.selectedHospital)}`)

  // ===== 4. 详情页无跨院拦截残留（Q8）=====
  console.log('\n[3] 详情页 Q8 回归')
  const lr = await callFn(mp, 'dealing', { action: 'list' })
  const pub = (lr && lr.dealings || []).find(x => x.status === 'published')
  record('前置：存在 published 单', !!pub, pub ? pub.title : '无')
  if (!pub) return finish(mp)
  await mp.reLaunch('/pages/detail/detail?id=' + pub._id)
  await sleep(2800)
  page = await curPage(mp)
  d = await page.data()
  record('详情数据不含 crossHospital 字段', !!d.dealing && !('crossHospital' in d), d.dealing ? `h=${d.dealing.hospitalName}` : '')
  // 全局 wxml 级断言：cross-card 元素不应存在（wx:if 条件已删除）
  const crossCard = await page.$('.cross-card')
  record('无"仅可浏览"拦截横幅', !crossCard, crossCard ? '!! 仍存在' : '已移除')

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
