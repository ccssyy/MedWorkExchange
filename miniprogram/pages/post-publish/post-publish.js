const app = getApp()

const TOPICS = [
  { key: 'gp_experience', label: '规培心得' },
  { key: 'case_discussion', label: '病例讨论' },
  { key: 'help', label: '求助提问' },
  { key: 'experience', label: '经验分享' },
  { key: 'exam', label: '考研考博' },
  { key: 'recruit', label: '招聘信息' },
  { key: 'chat', label: '闲聊灌水' }
]

Page({
  data: {
    topics: TOPICS,
    topicIndex: 0,
    title: '',
    content: '',
    images: [],
    isAnonymous: false,
    submitting: false
  },

  onTopicTap(e) {
    this.setData({ topicIndex: Number(e.currentTarget.dataset.index) })
  },

  onTitleInput(e) { this.setData({ title: e.detail.value }) },
  onContentInput(e) { this.setData({ content: e.detail.value }) },
  onAnonymousToggle() { this.setData({ isAnonymous: !this.data.isAnonymous }) },

  async onChooseImage() {
    if (this.data.images.length >= 3) {
      return wx.showToast({ title: '最多 3 张', icon: 'none' })
    }
    try {
      const res = await wx.chooseMedia({
        count: 3 - this.data.images.length,
        mediaType: ['image'],
        sizeType: ['compressed']
      })
      const uploading = res.tempFiles.map(f => this.uploadOne(f.tempFilePath))
      const fileIDs = await Promise.all(uploading)
      this.setData({ images: this.data.images.concat(fileIDs) })
    } catch (e) {
      // 用户取消
    }
  },

  uploadOne(filePath) {
    const ext = filePath.match(/\.(png|jpg|jpeg|webp)$/i)
    const cloudPath = `posts/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext ? ext[1] : 'png'}`
    return wx.cloud.uploadFile({ cloudPath, filePath }).then(r => r.fileID)
  },

  onRemoveImage(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const images = this.data.images.slice()
    images.splice(idx, 1)
    this.setData({ images })
  },

  async onSubmit() {
    const { topics, topicIndex, title, content, images, isAnonymous } = this.data
    if (!title.trim()) return wx.showToast({ title: '请填写标题', icon: 'none' })
    if (!content.trim()) return wx.showToast({ title: '请填写正文', icon: 'none' })

    const user = app.globalData.userInfo
    if (!user) {
      const res = await wx.cloud.callFunction({ name: 'login', data: { action: 'profile' } })
      app.globalData.userInfo = (res.result && res.result.user) || null
    }
    if (!app.globalData.userInfo || app.globalData.userInfo.verifyStatus !== 'verified') {
      return wx.showModal({
        title: '需要先认证',
        content: '发帖前请先完成医院认证',
        showCancel: false,
        success: () => wx.switchTab({ url: '/pages/profile/profile' })
      })
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '内容检测中…', mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'posts',
        data: {
          action: 'createPost',
          topic: topics[topicIndex].key,
          title: title.trim(),
          content: content.trim(),
          images,
          isAnonymous
        }
      })
      wx.hideLoading()
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: '发布成功', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 800)
      } else if (r.code === 'NOT_VERIFIED') {
        wx.showModal({ title: '需要先认证', content: '发帖前请先完成医院认证', showCancel: false })
      } else if (r.code === 'RISK_CONTENT' || r.code === 'RISK_IMAGE' || r.code === 'RISK_PRIVACY') {
        wx.showModal({ title: '内容未通过审核', content: r.message, showCancel: false })
      } else {
        wx.showToast({ title: r.message || '发布失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error(err)
      wx.showToast({ title: '发布失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
