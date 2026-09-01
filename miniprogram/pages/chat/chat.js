const app = getApp()
const db = wx.cloud.database()
const { reportFlow } = require('../../utils/report')

Page({
  data: {
    conversationId: '',
    dealingTitle: '',
    otherUid: '',
    messages: [],
    loading: true,
    hasMore: false,
    inputText: '',
    scrollInto: '',
    sending: false
  },

  watcher: null,
  pollTimer: null,
  oldestTime: null,

  onLoad(options) {
    this.setData({ conversationId: options.conversationId || '' })
    this.loadHistory()
  },

  onUnload() {
    this.stopLive()
  },

  onHide() {
    this.stopLive()
  },

  onShow() {
    // 从后台回来重新建立监听
    if (this.data.conversationId && this.data.messages.length) {
      this.startLive()
    }
  },

  loadHistory() {
    wx.cloud.callFunction({
      name: 'message',
      data: { action: 'messageList', conversationId: this.data.conversationId }
    }).then(res => {
      const r = res.result || {}
      if (!r.ok) {
        wx.showToast({ title: r.message || '加载失败', icon: 'none' })
        this.setData({ loading: false })
        return
      }
      const messages = r.messages || []
      if (messages.length) {
        this.oldestTime = messages[0].created_at
      }
      this.setData({
        messages,
        hasMore: r.hasMore,
        loading: false,
        dealingTitle: this.data.dealingTitle
      })
      this.scrollToBottom()
      // 进会话即标已读
      wx.cloud.callFunction({
        name: 'message',
        data: { action: 'markRead', conversationId: this.data.conversationId }
      })
      // 拉会话标题
      this.loadConvTitle()
      // 建立实时监听
      this.startLive()
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  loadConvTitle() {
    db.collection('conversations').doc(this.data.conversationId).get().then(res => {
      if (res.data) {
        const appInst = getApp()
        const me = appInst.globalData.userInfo && appInst.globalData.userInfo._id
        const otherUid = res.data.a_uid === me ? res.data.b_uid : res.data.a_uid
        this.setData({ dealingTitle: res.data.dealing_title || '', otherUid })
      }
    }).catch(() => {})
  },

  // ── 举报对方用户 ──
  async onReportUser() {
    if (!this.data.otherUid) {
      // otherUid 未取到时兜底：取最新一条非本人消息的发送方
      const otherMsg = this.data.messages.find(m => !m.mine)
      if (!otherMsg) return wx.showToast({ title: '暂无可举报的对象', icon: 'none' })
      this.setData({ otherUid: otherMsg.fromUid })
    }
    await reportFlow('user', this.data.otherUid)
  },

  loadMore() {
    if (!this.data.hasMore || !this.oldestTime) return
    wx.cloud.callFunction({
      name: 'message',
      data: {
        action: 'messageList',
        conversationId: this.data.conversationId,
        before: this.oldestTime
      }
    }).then(res => {
      const r = res.result || {}
      if (!r.ok) return
      const older = r.messages || []
      if (older.length) {
        this.oldestTime = older[0].created_at
        this.setData({
          messages: older.concat(this.data.messages),
          hasMore: r.hasMore
        })
      }
    })
  },

  // ── 实时监听（watch，异常降级轮询）──
  startLive() {
    this.stopLive()
    try {
      this.watcher = db.collection('messages')
        .where({ conversation_id: this.data.conversationId })
        .orderBy('created_at', 'asc')
        .watch({
          onChange: snapshot => {
            // docChanges 有新增才追加
            const added = (snapshot.docChanges || []).filter(d => d.dataType === 'add')
            if (added.length) this.mergeIncoming(added.map(d => d.doc))
          },
          onError: () => this.fallbackPoll()
        })
      // watch 连接健康检查：8s 内没建立则降级
      setTimeout(() => {
        if (!this.watcher) this.fallbackPoll()
      }, 8000)
    } catch (e) {
      this.fallbackPoll()
    }
  },

  fallbackPoll() {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => this.pollOnce(), 5000)
  },

  pollOnce() {
    wx.cloud.callFunction({
      name: 'message',
      data: { action: 'messageList', conversationId: this.data.conversationId }
    }).then(res => {
      const r = res.result || {}
      if (!r.ok) return
      const latest = r.messages || []
      // 以本地已有为基准追加新消息
      const known = new Set(this.data.messages.map(m => m._id))
      const fresh = latest.filter(m => !known.has(m._id))
      if (fresh.length) this.mergeIncoming(fresh.map(m => ({
        _id: m._id, from_uid: m.fromUid, content: m.content,
        created_at: m.created_at
      })))
    }).catch(() => {})
  },

  mergeIncoming(docs) {
    const me = (app.globalData.userInfo && app.globalData.userInfo.uid) || ''
    const known = new Set(this.data.messages.map(m => m._id))
    const fresh = docs
      .filter(d => !known.has(d._id))
      .map(d => ({
        _id: d._id,
        fromUid: d.from_uid,
        mine: d.from_uid === me,
        content: d.content,
        createdAgo: this.fmt(d.created_at),
        created_at: d.created_at
      }))
    if (!fresh.length) return
    const merged = this.data.messages.concat(fresh)
    this.oldestTime = merged.length ? merged[0].created_at : this.oldestTime
    this.setData({ messages: merged })
    this.scrollToBottom()
    // 对方消息即收即读
    wx.cloud.callFunction({
      name: 'message',
      data: { action: 'markRead', conversationId: this.data.conversationId }
    })
  },

  fmt(d) {
    if (!d) return ''
    const date = new Date(d)
    const pad = n => String(n).padStart(2, '0')
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  },

  stopLive() {
    if (this.watcher) { try { this.watcher.close() } catch (e) {} this.watcher = null }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
  },

  scrollToBottom() {
    const list = this.data.messages
    if (list.length) {
      this.setData({ scrollInto: 'msg-' + list[list.length - 1]._id })
    }
  },

  onInput(e) { this.setData({ inputText: e.detail.value }) },

  onSend() {
    const text = this.data.inputText.trim()
    if (!text || this.data.sending) return
    this.setData({ sending: true })
    wx.cloud.callFunction({
      name: 'message',
      data: {
        action: 'sendMessage',
        conversationId: this.data.conversationId,
        content: text
      }
    }).then(res => {
      const r = res.result || {}
      if (!r.ok) {
        wx.showToast({ title: r.message || '发送失败', icon: 'none' })
        return
      }
      // 本地乐观插入（watch/轮询也会补，按 _id 去重）
      this.mergeIncoming([{
        _id: r.messageId,
        from_uid: (app.globalData.userInfo && app.globalData.userInfo.uid) || 'me',
        content: text,
        created_at: new Date().toISOString()
      }])
      this.setData({ inputText: '' })
    }).catch(() => {
      wx.showToast({ title: '发送失败，请重试', icon: 'none' })
    }).finally(() => {
      this.setData({ sending: false })
    })
  }
})
