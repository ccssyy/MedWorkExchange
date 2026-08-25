Page({
  data: {
    conversations: [],
    loading: true
  },

  onShow() {
    this.loadConversations()
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

  onPullDownRefresh() {
    this.loadConversations()
    wx.stopPullDownRefresh()
  }
})
