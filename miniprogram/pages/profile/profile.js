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
    // 患者走患者激活；管理员可见审核入口；其余进医务认证提交页
    if (user && user.isPatient) {
      return wx.navigateTo({ url: '/pages/patient-activate/patient-activate' })
    }
    if (user && user.isAdmin) {
      wx.showActionSheet({
        itemList: ['提交/查看我的认证', '认证审核（管理）'],
        success: ({ tapIndex }) => {
          if (tapIndex === 0) wx.navigateTo({ url: '/pages/verify-submit/verify-submit' })
          else wx.navigateTo({ url: '/pages/admin-verify/admin-verify' })
        }
      })
      return
    }
    wx.navigateTo({ url: '/pages/verify-submit/verify-submit' })
  },

  goMyDealings() {
    wx.navigateTo({ url: '/pages/my-list/my-list?role=owner' })
  },

  goMyApplications() {
    wx.navigateTo({ url: '/pages/my-list/my-list?role=applicant' })
  }
})
