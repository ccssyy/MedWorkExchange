const app = getApp()

Page({
  data: {
    user: null,
    verifyStatusLabelMap: {
      none: '未认证',
      pending: '审核中',
      rejected: '未通过',
      verified: '已认证'
    }
  },

  onShow() {
    this.loadUser()
  },

  loadUser() {
    wx.cloud.callFunction({
      name: 'login',
      data: { action: 'profile' }
    }).then(res => {
      const user = (res.result && res.result.user) || null
      app.globalData.userInfo = user
      this.setData({ user })
    }).catch(err => {
      console.error('加载用户失败', err)
    })
  },

  goVerify() {
    wx.showModal({
      title: '医院认证',
      content: '认证功能即将开放：选择省-市-医院并提交学生证/工牌照片，人工审核通过后即可发布与接单',
      showCancel: false
    })
  },

  goMyDealings() {
    wx.navigateTo({ url: '/pages/my-list/my-list?role=owner' })
  },

  goMyApplications() {
    wx.navigateTo({ url: '/pages/my-list/my-list?role=applicant' })
  }
})
