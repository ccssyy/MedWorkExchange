// M5 UI 全链路（小程序端真实操作）：
// 打开提交页 → 选身份/选医院/填学信码 → 「＋」触发选图（mock 仅替代相册选择）
// → 真实 uploadFile 上云 → 提交云函数 → pending（OCR 未配→人工队列）
// → 管理员审核端列表 → 点「通过」→ verified → 库内落痕核查 → 页面回读
// 前置：账号须为 verify_status=none（否则先跑 reset_user_a.js）
const automator = require('miniprogram-automator')
const fs = require('fs')
const path = require('path')

const IMG = path.join(__dirname, '../fixtures/verify_material_sample.jpg')
const SHOT_DIR = path.join(__dirname, 'screenshots')
const CHSI = 'MWEUI20260911'
const PROBE_FILE = 'cloud://cloud1-d9gwlepe0f2e51cb8.636c-cloud1-d9gwlepe0f2e51cb8-1475356181/verify_materials/probe-userdata-1789095749082.jpg'

const results = []
const shots = []
function record(name, ok, note) {
  results.push({ name, ok: !!ok, note: note || '' })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`)
}
// 截图留证（mp.screenshot 截取当前模拟器画面；失败不影响断言）
async function shot(mp, name) {
  try {
    const file = path.join(SHOT_DIR, `${name}.png`)
    await mp.screenshot({ path: file })
    shots.push(file)
    console.log(`    📷 ${name}.png`)
    return file
  } catch (e) {
    console.log(`    截图失败(${name}): ${e.message}`)
    return null
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function callFn(mp, name, data) {
  return mp.evaluate((n, d) => new Promise((res) => {
    wx.cloud.callFunction({ name: n, data: d }).then(r => res(r.result)).catch(e => res({ __err: e.errMsg || String(e) }))
  }), name, data)
}
async function waitFor(fn, tries = 16, gap = 500) {
  for (let i = 0; i < tries; i++) {
    const v = await fn()
    if (v) return v
    await sleep(gap)
  }
  return null
}
async function waitPage(mp, key, tries = 20) {
  return waitFor(async () => {
    const p = await mp.currentPage()
    if (!p || p.path.indexOf(key) < 0) return null
    const d = await p.data()
    return d.statusLoading === false || d.loading === false ? p : null
  }, tries, 500)
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  console.log('[1] 连接 automator ...')
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  await mp.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' })

  // ===== 0. 前置：须为 none =====
  const my0 = await callFn(mp, 'verify', { action: 'myVerify' })
  record('前置：账号未认证(none)', !!(my0 && my0.status === 'none'), my0 ? String(my0.status) : '')
  if (!my0 || my0.status !== 'none') {
    console.log('    → 当前非 none 状态，终止（先跑 reset_user_a.js 复位）')
    return finish(mp)
  }

  // ===== 1. 打开提交页 =====
  console.log('\n[2] 提交页表单操作')
  await mp.reLaunch('/pages/verify-submit/verify-submit')
  const page = await waitPage(mp, 'verify-submit')
  record('提交页加载完成（statusLoading 门闩放行）', !!page, page ? page.path : 'timeout')
  if (!page) return finish(mp)

  const d0 = await page.data()
  record('未认证 → 渲染提交表单', d0.myStatus === 'none' && d0.hospitals.length > 0, `myStatus=${d0.myStatus}，医院 ${d0.hospitals.length} 家`)

  // ===== 2. 选身份：规培/实习生（材料要求 1 张）=====
  await page.callMethod('onRoleChange', { detail: { value: 1 } })
  const d1 = await page.data()
  record('选择身份「规培/实习生」', d1.roleIndex === 1, `roleIndex=${d1.roleIndex}`)

  // ===== 3. 选医院：吉林大学第一医院 =====
  const hIdx = d1.hospitals.findIndex(h => h.name.indexOf('吉林大学第一医院') >= 0)
  record('医院列表含吉大一院', hIdx >= 0, hIdx >= 0 ? d1.hospitals[hIdx].name : 'not found')
  await page.callMethod('onHospitalChange', { detail: { value: hIdx } })
  const dH = await page.data()
  record('医院已选中', dH.hospitalIndex === hIdx, `hospitalIndex=${dH.hospitalIndex}`)

  // ===== 4. 学信码（选填）=====
  await page.callMethod('onChsiInput', { detail: { value: CHSI } })

  // ===== 5. 材料上传：沙箱写文件 → mock 选图 → 点「＋」触发真实上云 =====
  console.log('\n[3] 材料上传（仅「选图」为 mock，上传真实）')
  const b64 = fs.readFileSync(IMG).toString('base64')
  const localPath = await mp.evaluate((dataB64) => new Promise(res => {
    const fsm = wx.getFileSystemManager()
    const p = `${wx.env.USER_DATA_PATH}/mwe_badge.jpg`
    fsm.writeFile({
      filePath: p, data: dataB64, encoding: 'base64',
      success: () => res(p), fail: e => res({ __err: e.errMsg })
    })
  }), b64)
  record('材料图写入模拟器沙箱', typeof localPath === 'string' && localPath.indexOf('http') === 0, String(localPath))
  await mp.mockWxMethod('chooseMedia', { tempFiles: [{ tempFilePath: localPath }], type: 'image' })

  const addBtn = await page.$('.img-add')
  record('定位「＋」上传入口', !!addBtn, addBtn ? '.img-add' : 'not found')
  if (addBtn) await addBtn.tap()

  const files = await waitFor(async () => {
    const dd = await page.data()
    return dd.files.length >= 1 ? dd.files : null
  }, 20, 500)
  record('真实上传云存储（拿到 cloud fileID）', !!(files && files[0].fileID.indexOf('cloud://') === 0),
    files ? files[0].fileID.slice(0, 62) : 'timeout')
  const d2 = await page.data()
  record('上传态复原 uploading=false', d2.uploading === false, `uploading=${d2.uploading}`)
  await sleep(1200) // 等缩略图（cloud:// 文件）渲染完成，否则截图里是空白占位
  await shot(mp, '01-提交表单已填好')

  // ===== 6. 提交 =====
  console.log('\n[4] 提交认证')
  const submitBtn = await page.$('.submit-btn')
  record('定位提交按钮', !!submitBtn, submitBtn ? '.submit-btn' : 'not found')
  if (submitBtn) await submitBtn.tap()

  const pending = await waitFor(async () => {
    const dd = await page.data()
    return dd.myStatus === 'pending' ? dd : null
  }, 20, 500)
  record('提交成功 → pending（OCR 未配 → 人工队列）', !!pending, pending ? `myStatus=${pending.myStatus}` : 'timeout')
  record('pending 状态卡渲染', !!(await page.$('.status-icon')), '')
  record('pending 后提交表单已隐藏', !(await page.$('.submit-btn')), '')
  await shot(mp, '02-提交后审核中')

  // ===== 7. 管理员审核端 =====
  console.log('\n[5] 管理员审核端')
  await mp.reLaunch('/pages/admin-verify/admin-verify')
  const adPage = await waitPage(mp, 'admin-verify')
  const adData = adPage ? await adPage.data() : null
  const mine = adData ? (adData.list || []).find(x => x.chsiCode === CHSI) : null
  record('审核端待审列表可见本人申请', !!mine, adData ? `${(adData.list || []).length} 条待审` : 'timeout')
  record('申请含材料（可预览）', !!(mine && mine.files.length >= 1), mine ? `${mine.files.length} 张 / ${mine.roleLabel}` : '')
  await shot(mp, '03-管理员审核端')

  // ===== 8. 点「通过」 =====
  if (mine) {
    await adPage.callMethod('onApprove', { currentTarget: { dataset: { uid: mine.uid } } })
    const vf = await waitFor(async () => {
      const m = await callFn(mp, 'verify', { action: 'myVerify' })
      return m && m.status === 'verified' ? m : null
    }, 16, 500)
    record('审核通过 → verified', !!vf, vf ? `${vf.status} / ${vf.hospitalName}` : 'timeout')
  }

  // ===== 9. 库内落痕核查（证明走了真实审核流，非直改）=====
  console.log('\n[6] 落库核查')
  const pk = await callFn(mp, 'initdb', { action: 'peek', testKey: 'mwe-test-only', collection: 'users', limit: 10 })
  const u = (pk.data || []).find(x => x._id && x._id.endsWith('61c24d'))
  const mat = u && u.verify_material
  record('manual_result=approved', !!(mat && mat.manual_result === 'approved'), mat ? String(mat.manual_result) : 'no material')
  record('reviewed_by 已写入（人工裁决留痕）', !!(mat && mat.reviewed_by), mat && mat.reviewed_by ? '...' + String(mat.reviewed_by).slice(-8) : '')
  record('auto_verified=false（未走 OCR 自动通过）', !!(mat && mat.auto_verified === false), mat ? String(mat.auto_verified) : '')
  record('医院锚点已写入（服务端隔离字段）', !!(u && u.hospital_id && u.hospitalName), u ? String(u.hospitalName) : '')
  record('材料为真实云文件 fileID', !!(mat && mat.files && mat.files[0] && mat.files[0].indexOf('cloud://') === 0),
    mat && mat.files ? mat.files[0].slice(0, 50) : '')
  record('is_admin 保留', !!(u && u.is_admin === true), u ? `is_admin=${u.is_admin}` : '')
  record('信用分未受影响(=100)', !!(u && u.credit_score === 100), u ? `credit=${u.credit_score}` : '')

  // ===== 10. 页面回读 =====
  console.log('\n[7] 回读')
  await mp.reLaunch('/pages/verify-submit/verify-submit')
  const backPage = await waitPage(mp, 'verify-submit')
  const bd = backPage ? await backPage.data() : null
  record('提交页回读 → verified 状态卡', !!(bd && bd.myStatus === 'verified'), bd ? `myStatus=${bd.myStatus}` : 'timeout')
  await shot(mp, '04-认证已完成')

  // ===== 11. 清理探针残留文件 =====
  const cleaned = await mp.evaluate((fid) => new Promise(res => {
    wx.cloud.deleteFile({ fileList: [fid], success: r => res({ ok: true, n: (r.fileList || []).length }), fail: e => res({ ok: false, err: e.errMsg }) })
  }), PROBE_FILE)
  console.log(`    探针残留文件清理: ${cleaned && cleaned.ok ? '已删除' : '跳过（' + (cleaned && cleaned.err) + '）'}`)

  await finish(mp)

  async function finish(mpi) {
    console.log('\n=== 汇总 ===')
    let fail = 0
    for (const r of results) {
      if (!r.ok) fail++
      console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name}${r.note ? ' | ' + r.note : ''}`)
    }
    console.log(fail === 0 ? '\n全部通过 ✓ 小程序端认证全链路走通（提交→人工审核→通过）' : `\n${fail} 项失败`)
    await mpi.disconnect()
    process.exit(fail === 0 ? 0 : 1)
  }
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
