// M5 医务认证验证：提交(OCR降级→pending)→防重→admin 列表→通过→状态回读→驳回+重交→revoke 保护
// 前置：模拟器已连接；无 OCR 凭证时自动走人工队列（降级路径本身即验证点）
const automator = require('miniprogram-automator')

const sleep = ms => new Promise(r => setTimeout(r, ms))
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

  // ===== 0. 权限位/认证位强制重置（防上轮遗留，主链路需从 none 开始）=====
  await callFn(mp, 'initdb', { action: 'setTestUser', testKey: 'mwe-test-only', isAdmin: false, verifyStatus: 'none' })

  // ===== 1. 非法参数 =====
  console.log('\n[2] 提交校验')
  const badRole = await callFn(mp, 'verify', { action: 'submitVerify', roleType: 'hacker', hospitalId: 'x', materials: [{ fileID: 'cloud://a' }] })
  record('非法 roleType 被拒', !!(badRole && !badRole.ok), JSON.stringify(badRole).slice(0, 60))

  // ===== 2. 合法提交（无真实文件，OCR 下载失败→降级人工；材料存 fileID 占位即可走通流程）=====
  // 说明：imgSecCheck 对无效 fileID 会失败但被 catch 跳过；OCR 下载失败同样降级 → pending
  const hospitals = await callFn(mp, 'hospital', { action: 'list' })
  const hospitalId = hospitals && hospitals.hospitals && hospitals.hospitals[0] ? hospitals.hospitals[0]._id : null
  record('前置：医院列表', !!hospitalId, hospitalId || '')
  if (!hospitalId) return finish(mp)

  // 先确保本人当前非 verified（若是，先不动业务字段——直接验证 myVerify 返回 verified 分支）
  const my0 = await callFn(mp, 'verify', { action: 'myVerify' })
  console.log('    当前认证状态:', my0 && my0.status)

  if (my0 && my0.status !== 'verified') {
    const sub = await callFn(mp, 'verify', {
      action: 'submitVerify',
      roleType: 'student',
      hospitalId,
      materials: [{ fileID: 'cloud://fake-id-1.jpg' }],
      chsiCode: 'TESTCHSI001'
    })
    record('提交成功(OCR降级→pending)', !!(sub && sub.ok && sub.status === 'pending'), JSON.stringify(sub).slice(0, 80))

    // ===== 3. pending 期间防重 =====
    const dup = await callFn(mp, 'verify', {
      action: 'submitVerify', roleType: 'doctor', hospitalId,
      materials: [{ fileID: 'cloud://fake-id-2.jpg' }]
    })
    record('pending 防重被拒', !!(dup && !dup.ok && dup.code === 'PENDING'), JSON.stringify(dup).slice(0, 60))

    // ===== 4. 非 admin 被拒 =====
    const forbidden = await callFn(mp, 'verify', { action: 'adminVerifyList' })
    record('非 admin 被拒', !!(forbidden && !forbidden.ok && forbidden.code === 'FORBIDDEN'), JSON.stringify(forbidden).slice(0, 60))

    // ===== 5. is_admin → 列表可见自己 → approve → 状态 verified =====
    console.log('\n[3] 人工审核流')
    await callFn(mp, 'initdb', { action: 'setTestUser', testKey: 'mwe-test-only', isAdmin: true })
    const list = await callFn(mp, 'verify', { action: 'adminVerifyList' })
    const me = list && list.ok ? (list.list || []).find(x => x.chsiCode === 'TESTCHSI001') : null
    record('adminList 可见待审(self)', !!me, list && list.ok ? `${(list.list || []).length} 条` : JSON.stringify(list).slice(0, 60))

    if (me) {
      // 驳回路径先测（后续可重交）
      const rej = await callFn(mp, 'verify', { action: 'adminVerify', uid: me.uid, verdict: 'reject', reason: '照片模糊' })
      record('adminVerify(reject) ok', !!(rej && rej.ok), JSON.stringify(rej).slice(0, 50))
      const my1 = await callFn(mp, 'verify', { action: 'myVerify' })
      record('myVerify 回读 rejected+理由', !!(my1 && my1.status === 'rejected' && my1.rejectReason === '照片模糊'),
        my1 ? `${my1.status}/${my1.rejectReason}` : '')

      // 重交 → approve
      const sub2 = await callFn(mp, 'verify', {
        action: 'submitVerify', roleType: 'student', hospitalId,
        materials: [{ fileID: 'cloud://fake-id-3.jpg' }], chsiCode: 'TESTCHSI002'
      })
      record('驳回后重交 ok', !!(sub2 && sub2.ok), JSON.stringify(sub2).slice(0, 50))

      const list2 = await callFn(mp, 'verify', { action: 'adminVerifyList' })
      const me2 = list2 && list2.ok ? (list2.list || []).find(x => x.chsiCode === 'TESTCHSI002') : null
      record('重交后再次可见', !!me2, me2 ? me2.roleLabel : '')
      if (me2) {
        const app2 = await callFn(mp, 'verify', { action: 'adminVerify', uid: me2.uid, verdict: 'approve' })
        record('adminVerify(approve) ok', !!(app2 && app2.ok), JSON.stringify(app2).slice(0, 50))
        const my2 = await callFn(mp, 'verify', { action: 'myVerify' })
        record('认证后状态 verified', !!(my2 && my2.status === 'verified'), my2 ? my2.status : '')

        // 非 pending 状态再裁决被拒
        const again = await callFn(mp, 'verify', { action: 'adminVerify', uid: me2.uid, verdict: 'revoke' })
        record('非 pending 再裁决被拒', !!(again && !again.ok && again.code === 'NOT_PENDING'), JSON.stringify(again).slice(0, 60))
      }
    }
  } else {
    record('前置：当前已 verified，跳过主链路', true, '如需重测请先手动改回 none')
  }

  // ===== 清理 =====
  console.log('\n[清理]')
  await callFn(mp, 'initdb', { action: 'setTestUser', testKey: 'mwe-test-only', isAdmin: false, verifyStatus: 'verified' })
  console.log('    is_admin 已撤销；认证状态恢复 verified（联调期约定）')

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
