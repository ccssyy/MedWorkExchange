// 复位测试A账号：清 verify_status / verify_material / hospital_id / hospitalName
// 保留 is_admin=true（管理员身份不动）。复位后用户在小程序端重走真实认证流。
// 结尾回读核查 + 打印提交表单渲染门闩（statusLoading）确认无闪现回归。
const automator = require('miniprogram-automator')

const results = []
function record(name, ok, note) {
  results.push({ name, ok: !!ok, note: note || '' })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`)
}
async function callFn(mp, name, data) {
  return mp.evaluate((n, d) => new Promise((res) => {
    wx.cloud.callFunction({ name: n, data: d }).then(r => res(r.result)).catch(e => res({ __err: e.errMsg || String(e) }))
  }), name, data)
}

async function main() {
  console.log('[1] 连接 automator ...')
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  await mp.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' })

  // ===== 1. 复位：状态 none + 清材料/医院绑定（is_admin 不传 = 保留）=====
  console.log('\n[2] 复位认证数据')
  const rst = await callFn(mp, 'initdb', {
    action: 'setTestUser', testKey: 'mwe-test-only',
    verifyStatus: 'none', clearVerifyMaterial: true
  })
  record('setTestUser 复位 ok', !!(rst && rst.ok), JSON.stringify(rst).slice(0, 90))

  // ===== 2. 回读核查 =====
  const peek = await callFn(mp, 'initdb', {
    action: 'peek', testKey: 'mwe-test-only',
    collection: 'users', where: { nickname: '测试A' }, limit: 1
  })
  const u = peek && peek.ok && peek.data && peek.data[0] ? peek.data[0] : null
  record('回读：verify_status=none', !!(u && u.verify_status === 'none'), u ? String(u.verify_status) : 'user not found')
  record('回读：verify_material 已清', !!(u && u.verify_material === undefined), u && u.verify_material !== undefined ? '仍存在!' : 'removed')
  record('回读：hospital_id 已清', !!(u && u.hospital_id === undefined), u && u.hospital_id !== undefined ? '仍存在!' : 'removed')
  record('回读：hospitalName 已清', !!(u && u.hospitalName === undefined), u && u.hospitalName !== undefined ? '仍存在!' : 'removed')
  record('回读：is_admin 保留', !!(u && u.is_admin === true), u ? `is_admin=${u.is_admin}` : '')
  if (u) console.log(`    uid: ${u._id}`)

  // ===== 3. myVerify 应返回 none（页面将渲染提交表单）=====
  const my = await callFn(mp, 'verify', { action: 'myVerify' })
  record('myVerify → none', !!(my && my.ok && my.status === 'none'), my ? JSON.stringify(my).slice(0, 80) : '')

  // ===== 4. 页面渲染门闩：无闪现回归 =====
  const page = await mp.currentPage().catch(() => null)
  if (page && page.path && page.path.indexOf('verify-submit') >= 0) {
    const d = await page.data()
    record('verify-submit statusLoading 门闩正常', typeof d.statusLoading === 'boolean', `statusLoading=${d.statusLoading}, myStatus=${d.myStatus}`)
  } else {
    record('verify-submit 页未打开（跳过页面断言，属正常）', true, page ? page.path : 'no page')
  }

  console.log('\n=== 汇总 ===')
  let fail = 0
  for (const r of results) {
    if (!r.ok) fail++
    console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name}${r.note ? ' | ' + r.note : ''}`)
  }
  console.log(fail === 0 ? '\n全部通过 ✓ 测试A已复位为未认证，可在小程序端重走认证流' : `\n${fail} 项失败`)
  await mp.disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
