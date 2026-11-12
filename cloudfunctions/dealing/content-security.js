// 内容安全三级管线（文本部分）——单一事实源
// 各云函数 require('./content-security')（部署前运行 node scripts/sync-common.js 同步到函数目录）
// 审计落库（audit_logs）由调用方按需执行：拦截结果带 gate/hit 供调用方记录
const cloud = require('wx-server-sdk')

// 本地黑名单（运营可扩展，Pilot 先用内置词）
const LOCAL_BLACKLIST = [
  '法轮功', '赌博', '代开发票', '毒品', '冰毒', '枪支', '买微信号',
  '加微信', '加V', '微信号', '转账到', '刷单', '代办证书'
]
// 患者隐私正则（身份证18位/手机号11位）
const PRIVACY_PATTERNS = [
  /\d{17}[\dXx]/,
  /1[3-9]\d{9}/
]
// 导流正则（合规红线 D3：联络一律站内完成；仅 message 私信使用）
const CONTACT_PATTERNS = [
  /1[3-9]\d{9}/,
  /微信号?\s*[:：]?\s*[a-zA-Z0-9_-]{5,}/i,
  /\b(v|vx|wx|weixin)\s*[:：]\s*[a-zA-Z0-9_-]{5,}/i
]

function maskWord(s) { return s.length > 2 ? s.slice(0, 2) + '**' : '**' }

// 第一道：本地黑名单 + 患者隐私正则
function checkLocal(text) {
  const t = String(text || '')
  for (const w of LOCAL_BLACKLIST) {
    if (t.includes(w)) {
      return { ok: false, code: 'RISK_CONTENT', gate: 'local_blacklist', hit: w,
        message: `内容含违规词（${maskWord(w)}），请修改` }
    }
  }
  for (const p of PRIVACY_PATTERNS) {
    if (p.test(t.replace(/[\s-]/g, ''))) {
      return { ok: false, code: 'RISK_PRIVACY', gate: 'privacy_pattern',
        message: '疑似患者隐私信息（身份证/手机号），请脱敏后发布' }
    }
  }
  return { ok: true }
}

// 私信导流拦截（仅 message 使用）：手机号/微信号/缩写前缀
function checkContact(text) {
  const t = String(text || '').replace(/[\s-]/g, '')
  for (const p of CONTACT_PATTERNS) {
    if (p.test(t)) {
      return { ok: false, code: 'CONTACT_LEAK', gate: 'contact_leak',
        message: '请勿在私信中留联系方式，请通过平台沟通（点击对方头像可看档案）' }
    }
  }
  return { ok: true }
}

// 第二道：msgSecCheck v2（87014 → RISK_CONTENT；其余异常 → SEC_CHECK_FAIL）
async function msgSecCheck(openid, text) {
  try {
    await cloud.openapi.security.msgSecCheck({
      openid, scene: 2, version: 2, content: text
    })
    return { ok: true }
  } catch (e) {
    if (e.errCode === 87014) {
      return { ok: false, code: 'RISK_CONTENT', gate: 'msgSecCheck', message: '内容含违规信息，请修改后重试' }
    }
    console.error('msgSecCheck error', e)
    return { ok: false, code: 'SEC_CHECK_FAIL', message: '系统繁忙，请稍后重试' }
  }
}

module.exports = { LOCAL_BLACKLIST, PRIVACY_PATTERNS, CONTACT_PATTERNS, checkLocal, checkContact, msgSecCheck }
