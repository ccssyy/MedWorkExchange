// notify 云函数离线逻辑验证（SDK 桩驱动，不连云、不写库）
// 运行：见 test/notify/README.md
const path = require('path')
const sdk = require('wx-server-sdk')

// 先取到模板配置对象（与 notify 内部 require 到的是同一个实例），便于在用例中临时填 ID
const TPL = require(path.join(__dirname, '../../cloudfunctions/notify/templates.js'))
const notify = require(path.join(__dirname, '../../cloudfunctions/notify/index.js'))

const H = 3600 * 1000
const hoursAgo = h => new Date(Date.now() - h * H)

let passed = 0
let failed = 0
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}
function rows(name) { return sdk.__store.all(name) }
function row(name, id) { return rows(name).find(d => d._id === id) }

function setIds(map) {
  Object.keys(TPL.templates).forEach(k => { TPL.templates[k].id = '' })
  Object.keys(map || {}).forEach(k => { TPL.templates[k].id = map[k] })
}

function seedUsers() {
  sdk.__store.seed('users', [
    { _id: 'u_a', openid: 'openid_a', nickname: 'A' },
    { _id: 'u_b', openid: 'openid_b', nickname: 'B' }
  ])
}

function seedNote(over) {
  return {
    _id: over._id,
    to_uid: over.to_uid || 'u_a',
    template_key: over.template_key || 'newApplication',
    page: over.page || '',
    payload: over.payload || { dealingTitle: '夜班换班', applicantName: '李医生', applyTime: new Date('2026-09-11T10:30:00') },
    status: 'pending',
    attempts: over.attempts || 0,
    created_at: over.created_at || hoursAgo(0.1),
    updated_at: hoursAgo(0.1)
  }
}

;(async () => {
  console.log('\n[A] 模板全未配置：不发送任何请求，积压 pending 作废')
  sdk.__store.reset(); seedUsers(); setIds({})
  sdk.__store.seed('notifications', [seedNote({ _id: 'n1' }), seedNote({ _id: 'n2' })])
  const dryA = await notify.main({ action: 'scan' })
  check('scan 报告 picked=2', dryA.picked === 2, JSON.stringify(dryA))
  check('scan 未写库（仍为 pending）', row('notifications', 'n1').status === 'pending')
  const runA = await notify.main({ Type: 'Timer' })
  check('真实 drain 把 pending 置 skipped', row('notifications', 'n1').status === 'skipped')
  check('原因为 templates_not_configured', row('notifications', 'n1').last_error_msg === 'templates_not_configured')
  check('未发出任何微信请求', sdk.__store.sendCalls().length === 0, String(sdk.__store.sendCalls().length))
  check('返回值含 note 提示', typeof runA.note === 'string' && runA.note.length > 0)

  console.log('\n[B] 鉴权边界')
  sdk.__store.reset(); seedUsers(); setIds({ newApplication: 'TPL_NEW_APP' })
  sdk.__store.seed('notifications', [seedNote({ _id: 'n1' })])
  const denied = await notify.main({ action: 'drain' })
  check('drain 无身份被拒', denied.ok === false && denied.code === 'FORBIDDEN')
  check('stats 无 testKey 被拒', (await notify.main({ action: 'stats' })).code === 'FORBIDDEN')
  check('send 无 testKey 被拒', (await notify.main({ action: 'send', templateKey: 'newApplication' })).code === 'FORBIDDEN')
  const tplOpen = await notify.main({ action: 'templates' })
  check('templates 无需鉴权且返回已配置 key', tplOpen.ok === true && tplOpen.ids.newApplication === 'TPL_NEW_APP', JSON.stringify(tplOpen.ids))
  check('templates 只返回非空 ID', Object.keys(tplOpen.ids).length === 1, JSON.stringify(tplOpen.ids))

  console.log('\n[C] 正常发送：字段清洗与请求载荷')
  sdk.__store.reset(); seedUsers(); setIds({ newApplication: 'TPL_NEW_APP' })
  sdk.__store.seed('notifications', [seedNote({
    _id: 'n1',
    payload: {
      dealingTitle: '这是一个非常非常非常长的需求标题需要被截断到二十字以内上限',
      applicantName: '李医生',
      applyTime: new Date('2026-09-11T10:30:00')
    }
  })])
  const runC = await notify.main({ Type: 'Timer' })
  const callC = sdk.__store.sendCalls()[0]
  check('sent=1', runC.sent === 1, JSON.stringify(runC))
  check('状态置 sent 且有 sent_at', row('notifications', 'n1').status === 'sent' && !!row('notifications', 'n1').sent_at)
  check('touser 解析为 openid', callC.touser === 'openid_a', callC.touser)
  check('templateId 正确', callC.templateId === 'TPL_NEW_APP')
  check('page 取模板默认值', callC.page === 'pages/my-list/my-list', callC.page)
  check('miniprogramState 透传', callC.miniprogramState === 'formal', callC.miniprogramState)
  check('thing1 截断至 20 字', Array.from(callC.data.thing1.value).length === 20, String(Array.from(callC.data.thing1.value).length) + ':' + callC.data.thing1.value)
  check('thing2 原样', callC.data.thing2.value === '李医生', callC.data.thing2.value)
  check('time3 格式化为中文年月日', callC.data.time3.value === '2026年9月11日 10:30', callC.data.time3.value)

  console.log('\n[D] 空值回落与字面量常量')
  sdk.__store.reset(); seedUsers(); setIds({ applicationResult: 'TPL_RESULT' })
  TPL.templates.applicationResult.fields.phrase2 = '=申请已通过'
  TPL.templates.applicationResult.fields.thing1 = 'dealingTitle'
  sdk.__store.seed('notifications', [seedNote({
    _id: 'n1', template_key: 'applicationResult',
    payload: { dealingTitle: '', resultText: '' }
  })])
  await notify.main({ Type: 'Timer' })
  const callD = sdk.__store.sendCalls()[0]
  check('thing 空值回落为「无」', callD.data.thing1.value === '无', callD.data.thing1.value)
  check('phrase 以 = 标记的字面量原样输出',
    callD.data.phrase2.value === '申请已通过' && Array.from(callD.data.phrase2.value).length <= 5,
    callD.data.phrase2.value)
  TPL.templates.applicationResult.fields.phrase2 = 'resultText'

  sdk.__store.reset(); seedUsers(); setIds({ newApplication: 'TPL_NEW_APP' })
  sdk.__store.seed('notifications', [seedNote({ _id: 'n1', payload: { applyTime: new Date('2026-09-11T10:30:00') } })])
  await notify.main({ Type: 'Timer' })
  const callD2 = sdk.__store.sendCalls()[0]
  check('payload 缺键不回落为键名（防止把 dealingTitle 当正文发出）',
    callD2.data.thing1.value === '无', callD2.data.thing1.value)

  console.log('\n[E] 错误分支：不可重试类直接定性')
  const cases = [
    { name: '用户拒收 43101 → skipped', errCode: 43101, status: 'skipped', msg: 'user_refused' },
    { name: '参数错误 47003 → failed', errCode: 47003, status: 'failed', msg: 'bad_params' },
    { name: 'openid 无效 40003 → failed', errCode: 40003, status: 'failed', msg: 'invalid_openid' },
    { name: '跳转页不存在 41030 → failed', errCode: 41030, status: 'failed', msg: 'page_not_exists' }
  ]
  for (const c of cases) {
    sdk.__store.reset(); seedUsers(); setIds({ newApplication: 'TPL_NEW_APP' })
    sdk.__store.seed('notifications', [seedNote({ _id: 'n1' })])
    sdk.__store.setSendBehavior(() => {
      const e = new Error('mock fail')
      e.errCode = c.errCode
      e.errMsg = 'mock'
      return e
    })
    await notify.main({ Type: 'Timer' })
    const d = row('notifications', 'n1')
    check(c.name, d.status === c.status && (d.last_error_msg || '').startsWith(c.msg), d.status + '/' + d.last_error_msg)
    check('  └ attempts 不递增（不重试）', d.attempts === 0, String(d.attempts))
  }

  console.log('\n[F] 错误分支：可重试类保留 pending 并累加 attempts')
  sdk.__store.reset(); seedUsers(); setIds({ newApplication: 'TPL_NEW_APP' })
  sdk.__store.seed('notifications', [seedNote({ _id: 'n1', attempts: 0 })])
  sdk.__store.setSendBehavior(() => { const e = new Error('busy'); e.errCode = -1; e.errMsg = 'system busy'; return e })
  const runF1 = await notify.main({ Type: 'Timer' })
  check('retry=1 且仍为 pending', runF1.retry === 1 && row('notifications', 'n1').status === 'pending')
  check('attempts 累加为 1', row('notifications', 'n1').attempts === 1, String(row('notifications', 'n1').attempts))
  check('错误码回写', row('notifications', 'n1').last_error_code === -1)

  sdk.__store.reset(); seedUsers(); setIds({ newApplication: 'TPL_NEW_APP' })
  sdk.__store.seed('notifications', [seedNote({ _id: 'n1', attempts: 2 })])
  sdk.__store.setSendBehavior(() => { const e = new Error('busy'); e.errCode = -1; e.errMsg = 'system busy'; return e })
  const runF2 = await notify.main({ Type: 'Timer' })
  check('达到 maxAttempts → failed', runF2.failed === 1 && row('notifications', 'n1').status === 'failed')
  check('  └ 原因为 retry_exhausted', (row('notifications', 'n1').last_error_msg || '').startsWith('retry_exhausted'))

  console.log('\n[G] 其他终态：未知模板 / 模板 ID 缺失 / 过期 / 接收方缺失')
  sdk.__store.reset(); seedUsers(); setIds({ newApplication: 'TPL_NEW_APP' })
  sdk.__store.seed('notifications', [
    seedNote({ _id: 'g1', template_key: 'notExistKey' }),
    seedNote({ _id: 'g2', template_key: 'newMessage' }),
    seedNote({ _id: 'g3', template_key: 'newApplication', created_at: hoursAgo(30) }),
    seedNote({ _id: 'g4', template_key: 'newApplication', to_uid: 'ghost_uid' }),
    // 同批中夹一条正常的，验证失败项不会中断批处理
    seedNote({ _id: 'g5', template_key: 'newApplication' })
  ])
  const runG = await notify.main({ Type: 'Timer' })
  check('未知模板 → failed/unknown_template',
    row('notifications', 'g1').status === 'failed' && row('notifications', 'g1').last_error_msg === 'unknown_template')
  check('模板 ID 缺失 → skipped/template_id_missing',
    row('notifications', 'g2').status === 'skipped' && row('notifications', 'g2').last_error_msg === 'template_id_missing')
  check('超过 TTL → skipped/expired',
    row('notifications', 'g3').status === 'skipped' && row('notifications', 'g3').last_error_msg === 'expired')
  check('接收方不存在 → failed/no_openid',
    row('notifications', 'g4').status === 'failed' && row('notifications', 'g4').last_error_msg === 'no_openid')
  check('混合批次中正常项仍被发出', row('notifications', 'g5').status === 'sent', row('notifications', 'g5').status)
  check('仅 1 条真实发出', sdk.__store.sendCalls().length === 1, String(sdk.__store.sendCalls().length))
  check('summary 分类计数齐全',
    runG.failed === 2 && runG.skipped === 2 && runG.sent === 1,
    JSON.stringify({ sent: runG.sent, skipped: runG.skipped, failed: runG.failed }))

  console.log('\n[H] scan 只读巡检不写库不发请求')
  sdk.__store.reset(); seedUsers(); setIds({ newApplication: 'TPL_NEW_APP' })
  sdk.__store.seed('notifications', [seedNote({ _id: 'n1' })])
  const runH = await notify.main({ action: 'scan' })
  check('报告 sent=1（预演）', runH.sent === 1 && runH.dryRun === true, JSON.stringify(runH.sent))
  check('未写库', row('notifications', 'n1').status === 'pending')
  check('未发请求', sdk.__store.sendCalls().length === 0)

  console.log('\n[I] 联调单发 send：成功与失败均回传实际载荷')
  sdk.__store.reset(); seedUsers(); setIds({ newApplication: 'TPL_NEW_APP' })
  const okSend = await notify.main({
    action: 'send', testKey: 'mwe-test-only', templateKey: 'newApplication',
    toUid: 'u_a', payload: { dealingTitle: '夜班换班', applicantName: '李医生', applyTime: new Date('2026-09-11T10:30:00') }
  })
  check('单发成功', okSend.ok === true && okSend.sentTo === 'openid_a', JSON.stringify(okSend))
  sdk.__store.setSendBehavior(() => { const e = new Error('x'); e.errCode = 47003; e.errMsg = 'field error'; return e })
  const badSend = await notify.main({
    action: 'send', testKey: 'mwe-test-only', templateKey: 'newApplication', toUid: 'u_a', payload: {}
  })
  check('单发失败回传 errCode', badSend.ok === false && badSend.errCode === 47003, JSON.stringify(badSend))
  check('单发失败回传 dataSent（便于核对字段映射）', !!badSend.dataSent && badSend.dataSent.thing1.value === '无', JSON.stringify(badSend.dataSent))
  console.log('\n[J] stats 观测接口')
  const st = await notify.main({ action: 'stats', testKey: 'mwe-test-only' })
  check('stats 返回分状态计数', st.ok === true && typeof st.counts.pending === 'number', JSON.stringify(st.counts))
  check('stats 返回最近问题条目', Array.isArray(st.recentProblems), typeof st.recentProblems)

  console.log('\n──────────────────────────────')
  console.log('PASS ' + passed + ' / FAIL ' + failed)
  process.exit(failed === 0 ? 0 : 1)
})().catch(e => {
  console.error('测试异常中断：', e)
  process.exit(1)
})
