// timer 云函数离线逻辑验证（SDK 桩驱动，不连云、不写库）
// 运行：见 test/timer/README.md
const path = require('path')
const sdk = require('wx-server-sdk')
const timer = require(path.join(__dirname, '../../cloudfunctions/timer/index.js'))

const H = 3600 * 1000
const NOW = Date.now()
const hoursAgo = h => new Date(NOW - h * H)
const hoursAhead = h => new Date(NOW + h * H)

let passed = 0
let failed = 0
function check(name, cond, extra) {
  if (cond) {
    passed += 1
    console.log('  PASS  ' + name)
  } else {
    failed += 1
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''))
  }
}
function pick(name, id) {
  return sdk.__store.all(name).find(d => d._id === id)
}

function seed() {
  sdk.__store.reset()
  sdk.__store.seed('users', [
    { _id: 'u_a', nickname: 'A', stats: { published: 0, completed: 0 } },
    { _id: 'u_b', nickname: 'B', stats: { published: 0, completed: 0 } }
  ])
  sdk.__store.seed('dealings', [
    // 规则1：到期未确认 → 应关闭
    { _id: 'd_expired', status: 'published', owner_uid: 'u_a', end_time: hoursAgo(2) },
    { _id: 'd_applied_expired', status: 'applied', owner_uid: 'u_a', end_time: hoursAgo(1) },
    // 规则1 反向：未到期不动
    { _id: 'd_future', status: 'published', owner_uid: 'u_a', end_time: hoursAhead(24) },
    // 规则1 反向：无排班时段（病例指导类）不自动关闭
    { _id: 'd_noschedule', status: 'published', owner_uid: 'u_a', end_time: null },
    // 规则2：80h → 应提醒（≥72 且 <96）
    { _id: 'd_remind', status: 'in_progress', owner_uid: 'u_a', accepted_uid: 'u_b', end_time: hoursAgo(80) },
    // 规则2：已提醒过 → 不重复提醒
    { _id: 'd_reminded', status: 'in_progress', owner_uid: 'u_a', accepted_uid: 'u_b', end_time: hoursAgo(80), reminded_at: hoursAgo(1) },
    // 规则2：100h → 应自动确认完成（锚点取 complete_requested_at）
    {
      _id: 'd_autoconfirm', status: 'in_progress', owner_uid: 'u_a', accepted_uid: 'u_b',
      complete_requested: true, complete_requested_at: hoursAgo(100), end_time: hoursAgo(200)
    },
    // 规则2 反向：仅 10h，不动
    { _id: 'd_normal', status: 'in_progress', owner_uid: 'u_a', accepted_uid: 'u_b', end_time: hoursAgo(10) },
    // 规则2 反向：已完结，不动
    { _id: 'd_completed', status: 'completed', owner_uid: 'u_a', accepted_uid: 'u_b', completed_at: hoursAgo(5) },
    // 规则3（默认关闭）：confirmed 后长期未开始履约
    { _id: 'd_stale', status: 'confirmed', owner_uid: 'u_a', accepted_uid: 'u_b', end_time: hoursAgo(200) }
  ])
  sdk.__store.seed('applications', [
    { _id: 'app_pending', dealing_id: 'd_expired', status: 'pending' },
    { _id: 'app_accepted', dealing_id: 'd_expired', status: 'accepted' }
  ])
}

;(async () => {
  console.log('\n[1] 越权防护：无触发器身份、无 testKey 的真实写库请求应被拒')
  seed()
  const denied = await timer.main({})
  check('返回 FORBIDDEN', denied.ok === false && denied.code === 'FORBIDDEN', JSON.stringify(denied))
  check('未产生任何写库', pick('dealings', 'd_expired').status === 'published')

  console.log('\n[2] 只读巡检 scan：应统计出正确命中数且不写库')
  seed()
  const scan = await timer.main({ action: 'scan' })
  check('ok 且 dryRun=true', scan.ok === true && scan.dryRun === true, JSON.stringify(scan))
  check('到期待关闭 = 2', scan.summary.expiredNoAccept === 2, String(scan.summary.expiredNoAccept))
  check('72h 待提醒 = 1', scan.summary.reminded72h === 1, String(scan.summary.reminded72h))
  check('96h 待自动完成 = 1', scan.summary.autoConfirmed96h === 1, String(scan.summary.autoConfirmed96h))
  check('扩展规则命中 = 0（默认关闭）', scan.summary.staleConfirmed === 0, String(scan.summary.staleConfirmed))
  check('dryRun 未写库：d_expired 仍 published', pick('dealings', 'd_expired').status === 'published')
  check('dryRun 未写库：d_remind 无 reminded_at', !pick('dealings', 'd_remind').reminded_at)
  check('dryRun 未写库：d_autoconfirm 仍 in_progress', pick('dealings', 'd_autoconfirm').status === 'in_progress')
  check('dryRun 未写库：未产生 audit_logs', sdk.__store.all('audit_logs').length === 0)
  check('dryRun 未写库：未产生 notifications', sdk.__store.all('notifications').length === 0)

  console.log('\n[3] 真实执行（testKey）：规则应逐条落库')
  seed()
  const run = await timer.main({ testKey: 'mwe-test-only' })
  check('ok 且 trigger=false', run.ok === true && run.trigger === false, JSON.stringify(run.summary))
  check('d_expired → cancelled / expired_no_accept',
    pick('dealings', 'd_expired').status === 'cancelled' &&
    pick('dealings', 'd_expired').close_reason === 'expired_no_accept',
    JSON.stringify(pick('dealings', 'd_expired')))
  check('d_applied_expired → cancelled',
    pick('dealings', 'd_applied_expired').status === 'cancelled')
  check('待处理申请被拒、已接受申请不动',
    pick('applications', 'app_pending').status === 'rejected' &&
    pick('applications', 'app_accepted').status === 'accepted',
    pick('applications', 'app_pending').status + '/' + pick('applications', 'app_accepted').status)
  check('d_future 不受影响', pick('dealings', 'd_future').status === 'published')
  check('d_noschedule 不受影响', pick('dealings', 'd_noschedule').status === 'published')
  check('d_remind 打上 reminded_at',
    pick('dealings', 'd_remind').reminded_at instanceof Date &&
    pick('dealings', 'd_remind').remind_reason === 'service_timeout_72h')
  check('d_autoconfirm → completed / auto_confirmed',
    pick('dealings', 'd_autoconfirm').status === 'completed' &&
    pick('dealings', 'd_autoconfirm').auto_confirmed === true &&
    pick('dealings', 'd_autoconfirm').complete_requested === false,
    JSON.stringify(pick('dealings', 'd_autoconfirm')))
  check('接单方 stats.completed +1', pick('users', 'u_b').stats.completed === 1, String(pick('users', 'u_b').stats.completed))
  check('d_stale 保持 confirmed（扩展规则关闭）', pick('dealings', 'd_stale').status === 'confirmed')
  check('audit_logs 留痕 2 条', sdk.__store.all('audit_logs').length === 2, String(sdk.__store.all('audit_logs').length))

  const notes = sdk.__store.all('notifications')
  check('入队通知 4 条（提醒 2 + 自动完成 2）', notes.length === 4, String(notes.length))
  check('提醒通知模板正确', notes.filter(n => n.template_key === 'serviceReminder').length === 2,
    JSON.stringify(notes.map(n => n.template_key)))
  check('自动完成通知模板正确', notes.filter(n => n.template_key === 'serviceAutoCompleted').length === 2)
  check('通知均带 to_uid 且初始为 pending', notes.every(n => n.to_uid && n.status === 'pending'))
  check('通知覆盖双方（owner + 接单方）', new Set(notes.map(n => n.to_uid)).size === 2, JSON.stringify(notes.map(n => n.to_uid)))
  check('通知带溯源字段与去重键', notes.every(n => n.biz_id === 'd_remind' || n.biz_id === 'd_autoconfirm') && notes.every(n => !!n.dedup_key))

  console.log('\n[4] 幂等性：重复执行不应重复计数或重复提醒')
  const run2 = await timer.main({ testKey: 'mwe-test-only' })
  check('到期 = 0', run2.summary.expiredNoAccept === 0, String(run2.summary.expiredNoAccept))
  check('提醒 = 0', run2.summary.reminded72h === 0, String(run2.summary.reminded72h))
  check('自动完成 = 0', run2.summary.autoConfirmed96h === 0, String(run2.summary.autoConfirmed96h))
  check('接单方 stats.completed 仍为 1（未重复计数）', pick('users', 'u_b').stats.completed === 1, String(pick('users', 'u_b').stats.completed))
  check('重复执行不重复入队通知', sdk.__store.all('notifications').length === 4, String(sdk.__store.all('notifications').length))

  console.log('\n[5] 触发器路径：带 Timer 标识的调用应被放行')
  const trig = await timer.main({ Type: 'Timer', TriggerName: 'timerHourly' })
  check('ok 且 trigger=true', trig.ok === true && trig.trigger === true, JSON.stringify(trig))
  check('返回值含规则参数回显', trig.rules && trig.rules.autoConfirmAfterHours === 96)

  console.log('\n──────────────────────────────')
  console.log('PASS ' + passed + ' / FAIL ' + failed)
  process.exit(failed === 0 ? 0 : 1)
})().catch(e => {
  console.error('测试异常中断：', e)
  process.exit(1)
})
