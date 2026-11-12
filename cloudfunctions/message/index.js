const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 内容安全（导流拦截 + msgSecCheck）——公共模块单一事实源，词表改动后运行 node scripts/sync-common.js 同步
const cs = require('./content-security')

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  // getUser 在 main 闭包内捕获 OPENID，禁止模块级全局（云函数实例热复用下并发会串号越权）
  const getUser = async () => {
    const found = await db.collection('users').where({ openid: OPENID }).get()
    return found.data[0] || null
  }
  const action = event.action || 'conversationList'
  const user = await getUser()
  if (!user && action !== 'conversationList') return { ok: false, message: '请先登录' }

  // ── 会话信息（标题 + 对方 uid）：chat 页取 otherUid 用，避免客户端直读库（云函数创建的会话对客户端不可见）──
  if (action === 'conversationGet') {
    const { conversationId } = event
    const conv = await db.collection('conversations').doc(conversationId).get().catch(() => null)
    if (!conv || !conv.data) return { ok: false, message: '会话不存在' }
    const c = conv.data
    if (c.a_uid !== user._id && c.b_uid !== user._id) {
      return { ok: false, code: 'FORBIDDEN', message: '无权查看该会话' }
    }
    const otherUid = c.a_uid === user._id ? c.b_uid : c.a_uid
    const other = await db.collection('users').doc(otherUid).get().catch(() => null)
    return {
      ok: true,
      dealingTitle: c.dealing_title || '',
      otherUid,
      otherNickname: (other && other.data && other.data.nickname) || '医同学'
    }
  }

  // ── 会话列表（带对方信息与未读数）──
  if (action === 'conversationList') {
    if (!user) return { conversations: [] }
    const res = await db.collection('conversations')
      .where(_.or([{ a_uid: user._id }, { b_uid: user._id }]))
      .orderBy('last_time', 'desc')
      .limit(50)
      .get()
    const convs = []
    for (const c of res.data) {
      const iAmA = c.a_uid === user._id
      const otherUid = iAmA ? c.b_uid : c.a_uid
      const other = await db.collection('users').doc(otherUid).get().catch(() => null)
      const otherData = other && other.data
      // 未读数：对方发给消息且 read=false 且非本人发送
      let unread = 0
      try {
        const cnt = await db.collection('messages').where({
          conversation_id: c._id, from_uid: otherUid, read: false
        }).count()
        unread = cnt.total
      } catch (e) { unread = 0 }
      convs.push({
        _id: c._id,
        dealingId: c.dealing_id,
        dealingTitle: c.dealing_title || '',
        otherNickname: (otherData && otherData.nickname) || '医同学',
        otherHospital: (otherData && otherData.hospitalName) || '',
        otherUid,
        lastMessage: c.last_message || '',
        lastTimeLabel: c.last_time ? formatTime(c.last_time) : '',
        unread
      })
    }
    return { conversations: convs }
  }

  // ── 消息历史（游标分页）──
  if (action === 'messageList') {
    const { conversationId, before } = event
    const conv = await db.collection('conversations').doc(conversationId).get().catch(() => null)
    if (!conv || !conv.data) return { ok: false, message: '会话不存在' }
    if (conv.data.a_uid !== user._id && conv.data.b_uid !== user._id) {
      return { ok: false, code: 'FORBIDDEN', message: '无权查看该会话' }
    }
    let q = db.collection('messages').where({ conversation_id: conversationId })
    if (before) q = q.where({ conversation_id: conversationId, created_at: _.lt(new Date(before)) })
    const res = await q.orderBy('created_at', 'desc').limit(30).get()
    const messages = res.data.reverse().map(m => ({
      _id: m._id,
      fromUid: m.from_uid,
      mine: m.from_uid === user._id,
      content: m.content,
      createdAgo: formatTime(m.created_at, true),
      created_at: m.created_at
    }))
    return { ok: true, messages, hasMore: res.data.length === 30 }
  }

  // ── 发送 ──
  if (action === 'sendMessage') {
    const { conversationId, content } = event
    const text = String(content || '').trim()
    if (!text) return { ok: false, message: '消息不能为空' }
    if (text.length > 500) return { ok: false, message: '单条不超过 500 字' }

    const conv = await db.collection('conversations').doc(conversationId).get().catch(() => null)
    if (!conv || !conv.data) return { ok: false, message: '会话不存在' }
    const c = conv.data
    if (c.a_uid !== user._id && c.b_uid !== user._id) {
      return { ok: false, code: 'FORBIDDEN', message: '无权在该会话发言' }
    }
    // 私信仅存在于锁定后的撮合单（防骚扰）
    const d = await db.collection('dealings').doc(c.dealing_id).get().catch(() => null)
    const dstatus = d && d.data ? d.data.status : ''
    if (!['confirmed', 'in_progress', 'completed'].includes(dstatus)) {
      return { ok: false, code: 'NOT_LOCKED', message: '撮合确认后才能开始沟通' }
    }

    // 内容安全：先导流拦截（合规红线 D3）再 msgSecCheck
    const leak = cs.checkContact(text)
    if (!leak.ok) return { ok: false, code: leak.code, message: leak.message }
    const sec = await cs.msgSecCheck(OPENID, text)
    if (!sec.ok) return sec

    const toUid = c.a_uid === user._id ? c.b_uid : c.a_uid
    const now = new Date()
    const added = await db.collection('messages').add({
      data: {
        conversation_id: conversationId,
        dealing_id: c.dealing_id,
        from_uid: user._id,
        to_uid: toUid,
        content: text,
        msg_type: 'text',
        read: false,
        created_at: now
      }
    })
    await db.collection('conversations').doc(conversationId).update({
      data: { last_message: text.slice(0, 50), last_time: now, updated_at: now }
    })
    // TODO(M3): 订阅消息通知收信方（授权征集在 M4 一起）
    return { ok: true, messageId: added._id }
  }

  // ── 标记已读 ──
  if (action === 'markRead') {
    const { conversationId } = event
    const conv = await db.collection('conversations').doc(conversationId).get().catch(() => null)
    if (!conv || !conv.data) return { ok: false, message: '会话不存在' }
    if (conv.data.a_uid !== user._id && conv.data.b_uid !== user._id) {
      return { ok: false, code: 'FORBIDDEN', message: '无权操作该会话' }
    }
    const otherUid = conv.data.a_uid === user._id ? conv.data.b_uid : conv.data.a_uid
    const r = await db.collection('messages').where({
      conversation_id: conversationId, from_uid: otherUid, read: false
    }).update({ data: { read: true } })
    return { ok: true, updated: (r.stats && r.stats.updated) || 0 }
  }

  // ── 未读总数（tabBar 角标）──
  if (action === 'unreadCount') {
    if (!user) return { ok: true, total: 0 }
    const convs = await db.collection('conversations')
      .where(_.or([{ a_uid: user._id }, { b_uid: user._id }]))
      .limit(50)
      .get()
    let total = 0
    for (const c of convs.data) {
      const otherUid = c.a_uid === user._id ? c.b_uid : c.a_uid
      const cnt = await db.collection('messages').where({
        conversation_id: c._id, from_uid: otherUid, read: false
      }).count()
      total += cnt.total
    }
    return { ok: true, total }
  }

  return { ok: false, message: '未知 action' }
}

function formatTime(d, withFull) {
  if (!d) return ''
  const date = new Date(d)
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  if (!withFull) {
    const sameDay = date.toDateString() === now.toDateString()
    if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
