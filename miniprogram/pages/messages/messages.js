Page({
  data: {
    conversations: [],
    loading: true
  },

  onShow() {
    this.loadConversations()
    this.updateTabBadge()
  },

  loadConversations() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'message',
      data: { action: 'conversationList' }
    }).then(res => {
      const { conversations = [] } = res.result || {}
      this.setData({ conversations, loading: false })
    }).catch(err => {
      console.error('加载会话失败', err)
      this.setData({ loading: false })
    })
  },

  // tabBar 未读角标
  updateTabBadge() {
    wx.cloud.callFunction({
      name: 'message',
      data: { action: 'unreadCount' }
    }).then(res => {
      const total = (res.result && res.result.total) || 0
      if (total > 0) {
        wx.setTabBarBadge({ index: 3, text: total > 99 ? '99+' : String(total) })
      } else {
        wx.removeTabBarBadge({ index: 3 }).catch(() => {})
      }
    }).catch(() => {})
  },

  onConvTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/chat/chat?conversationId=${id}` })
  },

  onPullDownRefresh() {
    this.loadConversations()
    wx.stopPullDownRefresh()
  }
})
