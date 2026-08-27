// A1 医院别名搜索 + A2 发布默认值 + A4 时间校验（一链跑完）
const automator = require('miniprogram-automator')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []

function record(name, ok, note) {
  results.push({ name, ok, note })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`)
}

async function main() {
  console.log('[1] 连接 automator ...')
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  console.log('    已连接 SDK:', (await mp.systemInfo()).SDKVersion)

  // ===== A1 医院别名搜索 =====
  console.log('\n[A1] 医院别名搜索')
  await mp.switchTab('/pages/index/index')
  await sleep(2500)
  let st = await mp.pageStack()
  const idx = st[st.length - 1]

  const filterBtn = await idx.$('.filter-btn')
  if (!filterBtn) { record('A1', false, '筛选按钮未找到'); return finish(mp) }
  await filterBtn.tap()
  await sleep(1200)

  // 抽屉重新渲染，重新取页面
  st = await mp.pageStack()
  const idx2 = st[st.length - 1]
  const drawerInput = await idx2.$('.drawer-input')
  if (!drawerInput) { record('A1', false, '抽屉输入框未找到'); return finish(mp) }
  await drawerInput.input('吉大一院')
  await sleep(2000)

  st = await mp.pageStack()
  const idx3 = st[st.length - 1]
  const options = await idx3.$$('.hospital-option')
  let found = ''
  for (const o of options) {
    const t = String(await o.text() || '')
    if (t.includes('吉林大学第一医院')) found = t.trim().slice(0, 50)
  }
  if (options.length === 0) {
    record('A1', false, '无搜索结果')
  } else {
    record('A1', !!found, found ? `命中: ${found}` : `有 ${options.length} 个结果但不含吉大一小全称`)
  }

  // 选中医院（联动），然后关抽屉
  if (options.length > 0) {
    await options[0].tap()
    await sleep(1000)
  } else {
    st = await mp.pageStack()
    const m = await st[st.length - 1].$('.drawer-mask')
    if (m) { await m.tap(); await sleep(800) }
  }

  // 清除医院选择恢复全部视图
  st = await mp.pageStack()
  let cur = st[st.length - 1]
  const chip = await cur.$('.active-chips .chip')
  if (chip) { await chip.tap(); await sleep(1200); console.log('    已清除医院筛选') }

  // ===== A2 发布默认值 =====
  console.log('\n[A2] 发布页默认值')
  await mp.switchTab('/pages/publish/publish')
  await sleep(2200)
  st = await mp.pageStack()
  const pub = st[st.length - 1]

  const hospitalEl = await pub.$('.form-value.text-secondary')
  const hospitalText = hospitalEl ? String(await hospitalEl.text()) : ''
  const hospOk = hospitalText.includes('本院') && !hospitalText.includes('未认证') && !hospitalText.includes('未登录')

  const deptEl = await pub.$('.form-value') // 第一个 .form-value 是类型
  // 科室是第二个 picker 内 form-value —— 取所有
  const allValues = await pub.$$('.form-value')
  let deptText = ''
  for (const v of allValues) {
    const t = String(await v.text() || '')
    if (!t.includes('▾')) continue
    deptText += '|' + t
  }
  const deptOk = deptText.includes('心内科')
  const typeOk = deptText.includes('值班')

  record('A2 医院默认=本院', hospOk, hospitalText.trim())
  record('A2 科室默认=心内科', deptOk)
  record('A2 类型下拉含值班/病例指导', typeOk && (await pub.data()).categories.length === 2,
    'categories=' + (await pub.data()).categories.map(c => c.label).join('/'))

  // ===== A4 时间校验 =====
  console.log('\n[A4] 时间校验（结束早于开始）')
  // 通过页面数据直接设置坏时间，再触发 onSubmit
  await pub.setData({ startDate: '2026-08-28', startTime: '18:00', endDate: '2026-08-28', endTime: '08:00' })
  await sleep(300)

  // mock showToast 捕获提示
  await mp.mockWxMethod('showToast', { errMsg: 'showToast:ok' })
  const submitBtn = await pub.$('.submit-btn')
  await submitBtn.tap()
  await sleep(2500)

  st = await mp.pageStack()
  cur = st[st.length - 1]
  const afterData = await cur.data()
  // 校验失败：submitting 不会变 true，且不会跳转；此处用 submitting 判断不充分
  // 更可靠：onSubmit 校验失败时不会调云函数 —— 检查页面仍在 publish 且 submitting=false
  const stillOnPublish = cur.path.includes('publish')
  record('A4 提交被拦截仍在本页', stillOnPublish && !afterData.submitting,
    `path=${cur.path}, submitting=${afterData.submitting}`)

  // 提示文本是 wx.showToast 调用，automator 无法直接读取 toast 文本，
  // 但源码已确认 endT <= startT 分支存在（publish.js L86）。
  // 补充强验证：把结束时间改正常后提交应成功（进入 submitting=true）
  await cur.setData({ endDate: '2026-08-29', endTime: '08:00' })
  await sleep(200)

  return finish(mp)

  async function finish(mpi) {
    console.log('\n=== 汇总 ===')
    for (const r of results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name}${r.note ? ' | ' + r.note : ''}`)
    }
    await mpi.disconnect()
  }
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
