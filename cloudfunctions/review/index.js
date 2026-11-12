const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const CREDIT_FLOOR = 60   // 低于此值限制发布/申请
const CREDIT_REVIEW_BONUS = 2

// 内容安全词表/正则单一事实源见 cloudfunctions/common/content-security.js（部署前 node scripts/sync-common.js 同步）
const cs = require('./content-security')

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  // getUser 在 main 闭包内捕获 OPENID，禁止模块级全局（云函数实例热复用下并发会串号越权）
  const getUser = async () => {
    const found = await db.collection('users').where({ openid: OPENID }).get()
    return found.data[0] || null
  }
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
      const local = cs.checkLocal(text)
      if (!local.ok) return { ok: false, code: local.code, message: local.message }
      const sec = await cs.msgSecCheck(OPENID, text.slice(0, 100))
      if (!sec.ok) return sec
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
