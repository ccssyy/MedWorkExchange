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
    const user = this.data.user
    // 医务工作者走医院认证；患者/家属走患者身份激活
    if (user && user.isPatient) {
      return wx.navigateTo({ url: '/pages/patient-activate/patient-activate' })
    }
    wx.showModal({
      title: '身份选择',
      content: '您是医务工作者（医院认证）还是患者/家属（陪诊需求）？',
      confirmText: '医务认证',
      cancelText: '患者/家属',
      success: (r) => {
        if (r.confirm) {
          wx.showModal({
            title: '医院认证',
            content: '认证功能即将开放：选择省-市-医院并提交学生证/工牌照片，人工审核通过后即可发布与接单',
            showCancel: false
          })
        } else {
          wx.navigateTo({ url: '/pages/patient-activate/patient-activate' })
        }
      }
    })
  },

  goMyDealings() {
    wx.navigateTo({ url: '/pages/my-list/my-list?role=owner' })
  },

  goMyApplications() {
    wx.navigateTo({ url: '/pages/my-list/my-list?role=applicant' })
  }
})
