Page({
  data: {
    id: '',
    post: null,
    gated: false,
    comments: [],
    loading: true,
    inputText: '',
    replyTarget: null,   // { commentId, name, isReply }
    inputPlaceholder: '说点什么…',
    submitting: false
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.loadPost()
  },

  loadPost() {
    wx.cloud.callFunction({
      name: 'posts',
      data: { action: 'getPost', postId: this.data.id }
    }).then(res => {
      const r = res.result || {}
      const post = r.post || null
      // 分级可见性：病例讨论帖对未认证用户锁定
      if (r.gated) {
        this.setData({ gated: true, loading: false })
        return
      }
      this.setData({ post, loading: false })
      this.loadComments()
    }).catch(() => this.setData({ loading: false }))
  },

  onGoVerify() {
    wx.switchTab({ url: '/pages/profile/profile' })
  },

  loadComments() {
    wx.cloud.callFunction({
      name: 'posts',
      data: { action: 'listComments', postId: this.data.id }
    }).then(res => {
      this.setData({ comments: (res.result && res.result.comments) || [] })
    })
  },

  onInput(e) { this.setData({ inputText: e.detail.value }) },

  onReplyTap(e) {
    const { id, name } = e.currentTarget.dataset
    this.setData({
      replyTarget: { commentId: id, name },
      inputPlaceholder: `回复 ${name}：`
    })
  },

  cancelReply() {
    this.setData({ replyTarget: null, inputPlaceholder: '说点什么…' })
  },

  async onSend() {
    const { inputText, replyTarget, submitting } = this.data
    if (submitting) return
    if (!inputText.trim()) return wx.showToast({ title: '请输入内容', icon: 'none' })
    this.setData({ submitting: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'posts',
        data: {
          action: 'comment',
          postId: this.data.id,
          parentId: replyTarget ? replyTarget.commentId : null,
          replyToName: replyTarget ? replyTarget.name : null,
          content: inputText.trim(),
          isAnonymous: false
        }
      })
      const r = res.result || {}
      if (r.ok) {
        this.setData({ inputText: '' })
        this.cancelReply()
        this.loadComments()
        this.loadPost()
      } else if (r.code === 'RISK_CONTENT' || r.code === 'RISK_PRIVACY') {
        wx.showModal({ title: '内容未通过审核', content: r.message, showCancel: false })
      } else {
        wx.showToast({ title: r.message || '发送失败', icon: 'none' })
      }
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '发送失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  async onToggleLike() {
    const res = await wx.cloud.callFunction({
      name: 'posts',
      data: { action: 'toggleLike', postId: this.data.id }
    }).catch(() => null)
    const r = res && res.result
    if (r && r.ok) this.loadPost()
  },

  async onDeletePost() {
    const confirmRes = await new Promise(resolve => {
      wx.showModal({
        title: '删除帖子',
        content: '删除后不可恢复，确认删除？',
        success: resolve
      })
    })
    if (!confirmRes.confirm) return
    const res = await wx.cloud.callFunction({
      name: 'posts',
      data: { action: 'deletePost', postId: this.data.id }
    }).catch(() => null)
    const r = res && res.result
    if (r && r.ok) {
      wx.showToast({ title: '已删除', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } else {
      wx.showToast({ title: (r && r.message) || '删除失败', icon: 'none' })
    }
  },

  async onDeleteComment(e) {
    const id = e.currentTarget.dataset.id
    const confirmRes = await new Promise(resolve => {
      wx.showModal({ title: '删除评论', content: '确认删除这条评论？', success: resolve })
    })
    if (!confirmRes.confirm) return
    const res = await wx.cloud.callFunction({
      name: 'posts',
      data: { action: 'deleteComment', commentId: id }
    }).catch(() => null)
    const r = res && res.result
    if (r && r.ok) {
      this.loadComments()
      this.loadPost()
    } else {
      wx.showToast({ title: (r && r.message) || '删除失败', icon: 'none' })
    }
  },

  onReport() {
    wx.showToast({ title: '举报功能即将开放', icon: 'none' })
  },

  onImagePreview(e) {
    const current = e.currentTarget.dataset.src
    wx.previewImage({ current, urls: this.data.post.images })
  }
})
