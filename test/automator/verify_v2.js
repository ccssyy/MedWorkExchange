// 编辑/下架全流程验证 v2（精确选择器版）
const automator = require('miniprogram-automator')

async function main() {
  console.log('[1] 连接 automator ...')
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  console.log('    已连接 SDK:', (await mp.systemInfo()).SDKVersion)

  // 先 mock showModal 自动确认（下架时用）
  await mp.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' })
  console.log('    已 mock showModal=confirm')

  const mark = 'AU' + String(Date.now()).slice(-6)
  console.log('[2] 标记:', mark)

  // 发布
  await mp.switchTab('/pages/publish/publish')
  await new Promise(r => setTimeout(r, 2000))
  let st = await mp.pageStack()
  let pub = st[st.length - 1]
  const inputs = await pub.$$('input')
  for (const inp of inputs) {
    const ph = String(await inp.attribute('placeholder') || '')
    if (ph.includes('求值')) await inp.input(mark + '自动化测试')
    if (ph.includes('选填')) await inp.input('66')
  }
  const submitBtn = await pub.$('.submit-btn')
  if (submitBtn) {
    await submitBtn.tap()
    console.log('    已点发布')
  }
  await new Promise(r => setTimeout(r, 3500))

  // 回列表找卡片
  await mp.switchTab('/pages/index/index')
  await new Promise(r => setTimeout(r, 2500))
  st = await mp.pageStack()
  const idx = st[st.length - 1]

  // 用 scroll-view 内的 .card 定位（排除 ad-slot）
  const cards = await idx.$$('.card')
  console.log('    卡片数:', cards.length)
  let target = null
  for (const c of cards) {
    const t = String(await c.text() || '')
    if (t.includes(mark)) { target = c; break }
  }
  if (!target) {
    console.log('    ! 列表未找到测试单，终止')
    await mp.disconnect()
    return
  }
  console.log('[3] 列表找到测试单 ✓')

  // 进详情
  await target.tap()
  await new Promise(r => setTimeout(r, 2500))
  st = await mp.pageStack()
  const cur = st[st.length - 1]
  console.log('[4] 详情页:', cur.path)
  if (!cur.path.includes('detail')) {
    console.log('    ! 未进入详情页，终止')
    await mp.disconnect()
    return
  }

  // 检查 isOwner 状态下按钮是否存在
  const editBtn = await cur.$('.op-edit')
  const offBtn = await cur.$('.op-offshelf')
  console.log('[5] 编辑按钮:', editBtn ? '存在' : '不存在', '下架按钮:', offBtn ? '存在' : '不存在')

  // 编辑流程
  if (editBtn) {
    await editBtn.tap()
    await new Promise(r => setTimeout(r, 1200))
    const eInput = await cur.$('.edit-input')
    if (eInput) {
      await eInput.input(mark + '-已改')
      console.log('    弹层标题已改')
    }
    // 找保存按钮
    const saveBtn = await cur.$('.edit-save, .edit-panel button')
    if (saveBtn) {
      await saveBtn.tap()
      console.log('    已点保存')
      await new Promise(r => setTimeout(r, 3000))
    }
    // 验证：重新加载详情或看标题
    st = await mp.pageStack()
    const cur2 = st[st.length - 1]
    const titleEl = await cur2.$('.title, .detail-title')
    const titleText = titleEl ? String(await titleEl.text()) : '(未找到标题元素)'
    console.log('[6] 编辑后标题:', titleText.slice(0, 40), titleText.includes(mark + '-已改') ? '✓ 生效' : '✗ 未生效')
  }

  // 下架流程（mock 已设置 confirm）
  const offBtn2 = await cur.$('.op-offshelf')
  if (offBtn2) {
    await offBtn2.tap()
    console.log('[7] 已点下架（showModal 自动确认）')
    await new Promise(r => setTimeout(r, 3500))
  }

  // 回列表验证消失
  await mp.switchTab('/pages/index/index')
  await new Promise(r => setTimeout(r, 2500))
  st = await mp.pageStack()
  const idx2 = st[st.length - 1]
  const cards2 = await idx2.$$('.card')
  let still = false
  for (const c of cards2) {
    const t = String(await c.text() || '')
    if (t.includes(mark)) { still = true; break }
  }
  console.log('[8] 下架后列表仍含测试单:', still, still ? '✗ 失败' : '✓ 成功')

  console.log('\n=== 汇总 ===')
  console.log('发布: ✓')
  console.log('编辑:', editBtn ? '(执行见上)' : '✗ 按钮未出现')
  console.log('下架:', !still ? '✓' : '✗')

  await mp.disconnect()
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
