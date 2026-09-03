const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// ── 角色与材料要求（表单按此动态渲染，服务端二次校验）──
const ROLE_TYPES = ['doctor', 'trainee', 'student']
// trainee=规培生/实习生（胸牌/实习证明），doctor=医生（执业证/工牌），student=在校学生（学生证+轮转材料）
const ROLE_LABELS = { doctor: '医生', trainee: '规培/实习生', student: '在校学生' }

// ── OCR 自动预审关键词库（医院名命中主条件 + 角色词辅条件）──
// 医院别名在运行时从 hospitals 表读取（initdb 已预置 aliases）
const ROLE_KEYWORDS = {
  doctor: ['执业', '医师', '医生', '工牌', '工作证'],
  trainee: ['规培', '住院医师', '实习', '进修'],
  student: ['学生', '学籍', '本科', '研究生', '临床']
}

// OCR 客户端（腾讯云文字识别）。未配置凭证时 ocrAvailable=false，全部进人工队列
let ocrClient = null
function initOcr() {
  if (ocrClient !== null) return ocrClient
  const secretId = process.env.OCR_SECRET_ID
  const secretKey = process.env.OCR_SECRET_KEY
  if (!secretId || !secretKey) {
    ocrClient = false
    return ocrClient
  }
  try {
    const tencentcloud = require('tencentcloud-sdk-nodejs-ocr')
    const Client = tencentcloud.ocr.v20181119.Client
    ocrClient = new Client({
      credential: { secretId, secretKey },
      region: 'ap-beijing',
      profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com' } }
    })
  } catch (e) {
    console.error('OCR SDK init failed (未安装依赖?)', e.message)
    ocrClient = false
  }
  return ocrClient
}

// 图片 → 文字（下载云存储文件后 base64 调用 GeneralBasicOCR）
async function ocrImage(fileID) {
  const client = initOcr()
  if (!client) return { available: false }
  try {
    const res = await cloud.downloadFile({ fileID })
    const r = await client.GeneralBasicOCR({
      ImageBase64: res.fileContent.toString('base64')
    })
    const text = (r.TextDetections || []).map(d => d.DetectedText).join('\n')
    return { available: true, text }
  } catch (e) {
    console.error('OCR call failed', e.message)
    return { available: false }
  }
}

// ── 自动判定：材料文字命中申请医院名(或别名) + 角色关键词 ──
function judgeMaterial(ocrText, hospitalNames, roleKeywords) {
  const t = ocrText.replace(/\s/g, '')
  const nameHit = hospitalNames.some(n => n && t.includes(n.replace(/\s/g, '')))
  const roleHit = roleKeywords.some(k => t.includes(k))
  if (nameHit && roleHit) return { verdict: 'auto_pass', nameHit, roleHit }
  return { verdict: 'manual', nameHit, roleHit }
}

async function getUser() {
  const found = await db.collection('users').where({ openid: OPENID_OF }).get()
  return found.data[0] || null
}

let OPENID_OF = null

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  OPENID_OF = OPENID
  const action = event.action
  const user = await getUser()
  if (!user) return { ok: false, message: '请先登录' }

  // ════════ 提交认证申请 ════════
  if (action === 'submitVerify') {
    const { roleType, hospitalId, materials, chsiCode } = event
    if (!ROLE_TYPES.includes(roleType)) return { ok: false, message: '请选择申请身份' }
    if (!hospitalId) return { ok: false, message: '请选择医院' }
    const mats = Array.isArray(materials) ? materials.filter(x => x && x.fileID) : []
    if (!mats.length) return { ok: false, message: '请上传认证材料照片' }
    if (mats.length > 3) return { ok: false, message: '材料最多 3 张' }

    const h = await db.collection('hospitals').doc(hospitalId).get().catch(() => null)
    if (!h || !h.data) return { ok: false, message: '医院不存在' }

    // 防重：pending 期间不允许重复提交
    if (user.verify_status === 'pending') {
      return { ok: false, code: 'PENDING', message: '已有申请在审核中，请耐心等待' }
    }

    // 图片内容安全（与 posts imgSecCheck 同源）
    for (const m of mats.slice(0, 3)) {
      try {
        await cloud.openapi.security.imgSecCheck({
          media: { contentType: 'image', value: (await cloud.downloadFile({ fileID: m.fileID })).fileContent }
        })
      } catch (e) {
        if (e.errCode === 87014) return { ok: false, message: '材料图片含违规内容' }
        console.error('imgSecCheck skip', e.message)
      }
    }

    // ── OCR 自动预审 ──
    // 医院名候选：全称 + 别名
    const nameCandidates = [h.data.name].concat(h.data.aliases || [])
    const roleWords = ROLE_KEYWORDS[roleType] || []
    let finalStatus = 'pending'
    const ocrDetails = []
    for (const m of mats) {
      const r = await ocrImage(m.fileID)
      if (!r.available) { ocrDetails.push({ fileID: m.fileID, ocr: 'unavailable' }); finalStatus = 'pending'; continue }
      const j = judgeMaterial(r.text, nameCandidates, roleWords)
      ocrDetails.push({ fileID: m.fileID, ocr: 'ok', nameHit: j.nameHit, roleHit: j.roleHit })
      if (j.verdict === 'auto_pass') finalStatus = 'verified'
    }
    // OCR 服务不可用 → 全部进人工（不阻塞申请）
    const ocrAvailable = ocrDetails.some(d => d.ocr === 'ok')

    const now = new Date()
    // 注意：存量用户 verify_material 可能是 null——Mongo 点路径 $set 无法在 null 上创建子字段，
    // 需先移除该字段再整体写入（remove 不报错，字段不存在时静默成功）
    if (user.verify_material === null || user.verify_material === undefined) {
      await db.collection('users').doc(user._id).update({
        data: { verify_material: _.remove() }
      }).catch(() => {})
    }
    const matPatch = {
      'verify_material.role_type': roleType,
      'verify_material.files': mats.map(m => m.fileID),
      'verify_material.chsi_code': String(chsiCode || '').trim().slice(0, 20) || null,
      'verify_material.ocr': { available: ocrAvailable, details: ocrDetails },
      'verify_material.auto_verified': finalStatus === 'verified',
      'verify_material.submitted_at': now,
      verify_status: finalStatus === 'verified' ? 'verified' : 'pending',
      hospital_id: hospitalId,               // 服务端写入，用户不可自选（隔离锚点）
      hospitalName: h.data.name,
      updated_at: now
    }
    await db.collection('users').doc(user._id).update({ data: matPatch })
    return {
      ok: true,
      status: finalStatus,
      autoVerified: finalStatus === 'verified',
      message: finalStatus === 'verified'
        ? '认证材料核验通过，已解锁发布与接单'
        : (ocrAvailable ? '材料已提交，平台将尽快完成人工审核' : '材料已提交，进入人工审核（预计 1 个工作日内）')
    }
  }

  // ════════ 我的认证状态 ════════
  if (action === 'myVerify') {
    return {
      ok: true,
      status: user.verify_status || 'none',
      roleType: user.verify_material ? user.verify_material.role_type : null,
      rejectReason: user.verify_status === 'rejected' && user.verify_material ? (user.verify_material.reject_reason || '') : null,
      hospitalName: user.hospitalName || ''
    }
  }

  // ════════ 以下为管理员接口 ════════
  if (!user.is_admin) return { ok: false, code: 'FORBIDDEN', message: '需要管理员权限' }

  // ── 待审列表 ──
  if (action === 'adminVerifyList') {
    const res = await db.collection('users').where({
      verify_status: 'pending'
    }).orderBy('updated_at', 'asc').limit(50).get()
    const list = res.data.map(u => ({
      uid: u._id,
      nickname: u.nickname || '?',
      roleType: u.verify_material ? u.verify_material.role_type : '?',
      roleLabel: u.verify_material ? ROLE_LABELS[u.verify_material.role_type] : '?',
      hospitalName: u.hospitalName || '',
      files: u.verify_material ? (u.verify_material.files || []) : [],
      chsiCode: u.verify_material ? u.verify_material.chsi_code : null,
      auto: u.verify_material ? !!u.verify_material.auto_verified : false,
      ocrAvailable: u.verify_material && u.verify_material.ocr ? !!u.verify_material.ocr.available : false,
      submittedAt: u.verify_material ? u.verify_material.submitted_at : null
    }))
    return { ok: true, list }
  }

  // ── 裁决：approve / reject ──
  if (action === 'adminVerify') {
    const { uid, verdict, reason } = event
    if (!uid) return { ok: false, message: '参数缺失' }
    const target = await db.collection('users').doc(uid).get().catch(() => null)
    if (!target || !target.data) return { ok: false, message: '用户不存在' }
    const tu = target.data
    if (tu.verify_status !== 'pending') return { ok: false, code: 'NOT_PENDING', message: '该申请不在待审状态' }
    // 防点路径写失败：material 为 null/undefined 时先移除字段
    if (tu.verify_material === null || tu.verify_material === undefined) {
      await db.collection('users').doc(uid).update({
        data: { verify_material: _.remove() }
      }).catch(() => {})
    }

    const now = new Date()
    if (verdict === 'approve') {
      // 通过：verified + 抽检标注；材料文件延迟清理放抽检后（pilot 先保留，隐私最小化后续做）
      await db.collection('users').doc(uid).update({
        data: {
          verify_status: 'verified',
          'verify_material.manual_result': 'approved',
          'verify_material.reviewed_by': user._id,
          'verify_material.reviewed_at': now,
          updated_at: now
        }
      })
      return { ok: true, message: '已通过认证' }
    }
    if (verdict === 'reject') {
      const why = String(reason || '').trim()
      if (!why) return { ok: false, message: '请填写驳回理由' }
      await db.collection('users').doc(uid).update({
        data: {
          verify_status: 'rejected',
          'verify_material.manual_result': 'rejected',
          'verify_material.reject_reason': why.slice(0, 50),
          'verify_material.reviewed_by': user._id,
          'verify_material.reviewed_at': now,
          updated_at: now
        }
      })
      return { ok: true, message: '已驳回' }
    }
    // 撤销（抽检发现问题）
    if (verdict === 'revoke') {
      const why = String(reason || '').trim() || '认证材料复核未通过'
      await db.collection('users').doc(uid).update({
        data: {
          verify_status: 'rejected',
          'verify_material.manual_result': 'revoked',
          'verify_material.reject_reason': why.slice(0, 50),
          'verify_material.reviewed_by': user._id,
          'verify_material.reviewed_at': now,
          credit_score: _.inc(-20),
          updated_at: now
        }
      })
      return { ok: true, message: '已撤销认证并扣 20 信用分' }
    }
    return { ok: false, message: '未知裁决' }
  }

  return { ok: false, message: '未知 action' }
}
