const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const CREDIT_FLOOR = 60   // 低于此值限制发布/申请
const CREDIT_REVIEW_BONUS = 2

// 与 posts/dealing/message 同源的本地黑名单 + 隐私正则（三级管线第一道）
const LOCAL_BLACKLIST = [
  '法轮功', '赌博', '代开发票', '毒品', '冰毒', '枪支', '买微信号',
  '加微信', '加V', '微信号', '转账到', '刷单', '代办证书'
]
const PRIVACY_PATTERNS = [
  /\d{17}[\dXx]/,
  /1[3-9]\d{9}/
]

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

  // ── 提交互评 ──
  if (action === 'submit') {
    const { dealingId, rating, content } = event
    const score = Number(rating)
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return { ok: false, message: '评分需为 1-5 星' }
    }
    const d = await db.collection('dealings').doc(dealingId).get().catch(() => null)
    if (!d || !d.data) return { ok: false, message: '撮合单不存在' }
    const dealing = d.data
    if (dealing.status !== 'completed') {
      return { ok: false, message: '履约完成后才能互评' }
    }
    // 仅撮合双方
    const isOwner = dealing.owner_uid === user._id
    const isAccepter = dealing.accepted_uid === user._id
    if (!isOwner && !isAccepter) return { ok: false, code: 'FORBIDDEN', message: '仅撮合双方可评价' }

    const toUid = isOwner ? dealing.accepted_uid : dealing.owner_uid
    if (!toUid || toUid === user._id) return { ok: false, message: '评价对象缺失' }

    // 防重：同一单同一评价人只评一次
    const dup = await db.collection('reviews').where({
      dealing_id: dealingId, from_uid: user._id
    }).count()
    if (dup.total > 0) return { ok: false, code: 'DUP', message: '已评价过该次履约' }

    // 内容安全三级管线同源：本地黑名单 + 隐私正则 → msgSecCheck（评论可留可不留，留了就审）
    const text = String(content || '').trim()
    if (text) {
      for (const w of LOCAL_BLACKLIST) {
        if (text.includes(w)) {
          return { ok: false, code: 'RISK_CONTENT', message: `评价含违规词，请修改` }
        }
      }
      for (const p of PRIVACY_PATTERNS) {
        if (p.test(text.replace(/[\s-]/g, ''))) {
          return { ok: false, code: 'RISK_PRIVACY', message: '含手机号/身份证等隐私信息，请修改' }
        }
      }
      try {
        await cloud.openapi.security.msgSecCheck({
          openid: OPENID, scene: 2, version: 2, content: text.slice(0, 100)
        })
      } catch (e) {
        if (e.errCode === 87014) return { ok: false, code: 'RISK_CONTENT', message: '评价内容含违规信息' }
        console.error('msgSecCheck error', e)
        return { ok: false, code: 'SEC_CHECK_FAIL', message: '系统繁忙，请稍后重试' }
      }
    }

    const now = new Date()
    await db.collection('reviews').add({
      data: {
        dealing_id: dealingId,
        from_uid: user._id,
        from_nickname: user.nickname || '',
        to_uid: toUid,
        rating: score,
        content: text.slice(0, 100),
        created_at: now
      }
    })
    // 信用分 +2（被评人）
    await db.collection('users').doc(toUid).update({
      data: { credit_score: _.inc(CREDIT_REVIEW_BONUS), updated_at: now }
    }).catch(() => {})
    return { ok: true }
  }

  // ── 查某单我的评价状态 + 对方是否已评 ──
  if (action === 'status') {
    const { dealingId } = event
    const mine = await db.collection('reviews').where({
      dealing_id: dealingId, from_uid: user._id
    }).get()
    const received = await db.collection('reviews').where({
      dealing_id: dealingId, to_uid: user._id
    }).get()
    return {
      ok: true,
      myReview: mine.data[0] ? { rating: mine.data[0].rating, content: mine.data[0].content } : null,
      receivedReview: received.data[0] ? { rating: received.data[0].rating, from: received.data[0].from_nickname } : null
    }
  }

  return { ok: false, message: '未知 action' }
}
