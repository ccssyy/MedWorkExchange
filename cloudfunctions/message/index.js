const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'conversationList'

  // M3 里程碑实现完整私信；当前返回用户相关的会话占位（数据流就绪）
  if (action === 'conversationList') {
    const found = await db.collection('users').where({ openid: OPENID }).get()
    const user = found.data[0]
    if (!user) return { conversations: [] }
    const res = await db.collection('conversations')
      .where(db.command.or([
        { a_uid: user._id },
        { b_uid: user._id }
      ]))
      .orderBy('last_time', 'desc')
      .limit(50)
      .get()
    return {
      conversations: res.data.map(c => ({
        _id: c._id,
        dealingId: c.dealing_id,
        dealingTitle: c.dealing_title || '',
        lastMessage: c.last_message || '',
        lastTimeLabel: c.last_time ? formatTime(c.last_time) : ''
      }))
    }
  }

  return { ok: false, message: '未知 action' }
}

function formatTime(d) {
  if (!d) return ''
  const date = new Date(d)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const pad = n => String(n).padStart(2, '0')
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${date.getMonth() + 1}/${date.getDate()}`
}
