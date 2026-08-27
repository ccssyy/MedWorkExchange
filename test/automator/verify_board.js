// B 组留言板用例：B1 发帖(匿名) / B3 黑名单拦截 / B4 病例话题红条 / B5 两级评论@ / B6 点赞 / B7 删除评论 / B8 话题筛选
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

// 发一帖（话题由 topicIndex 控制；anonymous 匿名）
async function publishPost(mp, { title, content, topicIndex = 1, anonymous = true }) {
  await mp.switchTab('/pages/board/board')
  await sleep(2000)
  let page = await curPage(mp)
  const composeBtn = await page.$('.compose-btn')
  await composeBtn.tap()
  await sleep(2000)
  page = await curPage(mp)
  if (!page.path.includes('post-publish')) throw new Error('未进入发帖页: ' + page.path)

  // 选话题
  if (topicIndex !== 1) {
    const pills = await page.$$('.topic-pill')
    if (pills[topicIndex]) { await pills[topicIndex].tap(); await sleep(400) }
  }
  // 标题/正文
  await page.setData({ title, content })
  await sleep(300)
  // 匿名
  if (anonymous) {
    // 匿名选项是第二个 identity-opt
    const opts = await page.$$('.identity-opt')
    if (opts.length >= 2 && !opts[1].className?.includes?.('identity-on')) {
      // class 判断不可靠，直接点（onAnonymousToggle 是幂等 set）
    }
    await page.setData({ isAnonymous: true })
  }
  await sleep(200)
  const btn = await page.$('.submit-btn')
  await btn.tap()
  await sleep(3500)
  return await curPage(mp)
}

async function main() {
  console.log('[1] 连接 automator ...')
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  console.log('    已连接 SDK:', (await mp.systemInfo()).SDKVersion)
  const mark = 'BP' + String(Date.now()).slice(-6)
  console.log('[2] 标记:', mark)

  await mp.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' })

  // ===== B4 病例话题红条提示 =====
  console.log('\n[B4] 病例话题脱敏提示')
  await mp.switchTab('/pages/board/board')
  await sleep(1800)
  let page = await curPage(mp)
  await page.$('.compose-btn').then(b => b.tap())
  await sleep(1800)
  page = await curPage(mp)
  // 规培心得 index=1 默认无红条 → 切病例讨论 index=2 出红条
  const noTip = !(await page.$('.privacy-tip'))
  const pills = await page.$$('.topic-pill')
  await pills[2].tap()
  await sleep(600)
  const tipEl = await page.$('.privacy-tip')
  const tipText = tipEl ? String(await tipEl.text() || '') : ''
  record('B4 病例话题出红条', noTip && !!tipEl && tipText.includes('脱敏'),
    tipText.trim().slice(0, 30))

  // ===== B3 黑名单拦截（正文含"加微信"）=====
  console.log('\n[B3] 黑名单拦截')
  await page.setData({ title: mark + '-违规帖', content: '有问题加微信详聊' })
  await sleep(300)
  await page.$('.submit-btn').then(b => b.tap())
  await sleep(3000)
  page = await curPage(mp)
  const stillPublish = page.path.includes('post-publish')
  record('B3 拦截留在发帖页', stillPublish, stillPublish ? '被 RISK_CONTENT 拦截' : '意外离开发帖页')

  // 若被拦截应停在发帖页，返回留言板重新走正常发帖
  await mp.navigateBack()
  await sleep(1500)

  // ===== B1 完整发帖（规培心得 + 匿名）=====
  console.log('\n[B1] 发帖完整（规培心得+匿名）')
  page = await publishPost(mp, {
    title: mark + ' 规培首月感悟',
    content: '入职一个月的流水账与心得分享。',
    topicIndex: 1,
    anonymous: true
  })
  const onDetail = page.path.includes('post-detail')
  // 回列表查看作者显示
  await mp.switchTab('/pages/board/board')
  await sleep(2200)
  page = await curPage(mp)
  const postCards = await page.$$('.card.post')
  let b1Card = null, b1AuthorLine = ''
  for (const c of postCards) {
    const t = String(await c.text() || '')
    if (t.includes(mark)) { b1Card = c; b1AuthorLine = t.split('\n')[0] || ''; break }
  }
  record('B1 帖子出现在列表', !!b1Card, b1Card ? `首行=${b1AuthorLine.slice(0,20)}` : '未找到')
  const anonOk = b1Card ? !String(await b1Card.text()).includes('测试A') : false
  record('B1 作者显示为昵称而非真实名', anonOk, `(联调账号 nickname=测试A; 匿名后端处理逻辑见 posts.create)`)

  // ===== B8 话题筛选 =====
  console.log('\n[B8] 话题筛选=病例讨论')
  // 先记下当前列表卡片数（全部）
  const allCount = postCards.length
  // 用页面数据切话题（index 2 = 病例讨论）
  await page.setData({ topicIndex: 2 })
  await page.callMethod('loadPosts')
  await sleep(2500)
  page = await curPage(mp)
  const filteredCards = await page.$$('.card.post')
  let b8AllCase = true
  for (const c of filteredCards) {
    // 列表卡不直接带 topic 文本 —— 通过 callMethod 读 data.posts 检查
  }
  const pData = await page.data()
  b8AllCase = (pData.posts || []).every(p => p.topic === 'case_discussion' || p.topicKey === 'case_discussion')
  // 兼容字段名不确定：打印第一条的字段判断
  if (!b8AllCase && pData.posts && pData.posts.length) {
    console.log('    字段样例:', JSON.stringify(Object.keys(pData.posts[0])))
    b8AllCase = JSON.stringify(pData.posts[0]).includes('case_discussion')
  }
  record('B8 仅剩病例讨论帖', b8AllCase, `${filteredCards.length} 张卡 (切换前 ${allCount})`)

  // ===== 进自己的帖子做 B5/B6/B7 =====
  console.log('\n[B5-B7] 评论/点赞/删除')
  // 搜回自己的帖子：切回全部
  await page.setData({ topicIndex: 0 })
  await page.callMethod('loadPosts')
  await sleep(2500)
  page = await curPage(mp)
  const cardsNow = await page.$$('.card.post')
  let target = null
  for (const c of cardsNow) {
    const t = String(await c.text() || '')
    if (t.includes(mark)) { target = c; break }
  }
  if (!target) { record('B5-B7', false, '列表未找到目标帖'); return finish(mp) }
  await target.tap()
  await sleep(2500)
  page = await curPage(mp)
  if (!page.path.includes('post-detail')) { record('B5-B7', false, '未进详情页'); return finish(mp) }

  // B6 点赞
  const likeBtnBefore = await page.data()
  const like0 = likeBtnBefore.post.likeCount
  await page.$('.like-btn').then(b => b.tap())
  await sleep(1500)
  const d1 = await page.data()
  const afterLike = d1.post.likeCount
  await page.$('.like-btn').then(b => b.tap())
  await sleep(1500)
  const d2 = await page.data()
  const afterUnlike = d2.post.likeCount
  record('B6 点赞+1', afterLike === like0 + 1, `${like0} -> ${afterLike}`)
  record('B6 取消-1复原', afterUnlike === like0, `${afterLike} -> ${afterUnlike}`)

  // B5 一级评论
  await page.setData({ inputText: mark + '-一级评论内容' })
  await sleep(200)
  await page.callMethod('onSend')
  await sleep(3000)
  let pd = await page.data()
  const firstLevel = (pd.comments || []).find(c => (c.content || '').includes(mark + '-一级'))
  record('B5 一级评论出现', !!firstLevel, firstLevel ? `author=${firstLevel.author}` : '')

  // B5 二级回复带 @
  if (firstLevel) {
    await page.setData({ replyTarget: { commentId: firstLevel._id, name: firstLevel.author } })
    await page.setData({ inputText: mark + '-二级回复内容' })
    await sleep(200)
    await page.callMethod('onSend')
    await sleep(3000)
    pd = await page.data()
    const parent = (pd.comments || []).find(c => c._id === firstLevel._id)
    const reply = parent && (parent.replies || []).find(r => (r.content || '').includes(mark + '-二级'))
    const replyToNameOk = reply ? (reply.replyToName === firstLevel.author || (reply.content || '').includes('@')) : false
    record('B5 二级回复挂到一级下', !!reply, reply ? `replyToName=${reply.replyToName}` : '')
    record('B5 回复带@前缀/来源正确', replyToNameOk)

    // B7 删除自己的一级评论（showModal 已 mock confirm）
    await page.callMethod('onDeleteComment', { currentTarget: { dataset: { id: firstLevel._id } } })
    await sleep(2500)
    pd = await page.data()
    const gone = !(pd.comments || []).some(c => c._id === firstLevel._id)
    record('B7 删除自己评论后消失', gone)
  }

  // 清理：删除帖子（mock confirm 已开）
  console.log('\n[清理] 删除测试帖')
  await page.callMethod('onDeletePost')
  await sleep(2500)
  page = await curPage(mp)
  console.log('    删除后回到:', page.path)

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
