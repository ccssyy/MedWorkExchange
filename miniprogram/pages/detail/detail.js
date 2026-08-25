const app = getApp()

Page({
  data: {
    id: '',
    dealing: null,
    applications: [],
    isOwner: false,
    crossHospital: false,
    myApplication: null,
    loading: true,
    applyMessage: '',
    applying: false,
    categoryLabelMap: {
      shift: '换班',
      case_guide: '病例指导',
      resume_guide: '简历指导'
    },
    statusLabelMap: {
      published: '待接单',
      applied: '申请中',
      confirmed: '已确认',
      in_progress: '履约中',
      completed: '已完成',
      cancelled: '已取消',
      disputed: '争议中'
    }
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.loadDetail()
  },

  loadDetail() {
    wx.cloud.callFunction({
      name: 'dealing',
      data: { action: 'get', dealingId: this.data.id }
    }).then(res => {
      const r = res.result || {}
      const dealing = r.dealing
      if (!dealing) {
        this.setData({ loading: false })
        return wx.showToast({ title: '撮合单不存在', icon: 'none' })
      }
      dealing.categoryLabel = this.data.categoryLabelMap[dealing.category] || dealing.category
      dealing.statusLabel = this.data.statusLabelMap[dealing.status] || dealing.status
      dealing.feeLabel = dealing.fee ? `${dealing.fee} 元（线下与对方结清）` : '面议'
      this.setData({
        dealing,
        isOwner: !!r.isOwner,
        crossHospital: !!r.crossHospital,
        applications: r.applications || [],
        myApplication: r.myApplication || null,
        loading: false
      })
    }).catch(err => {
      console.error(err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  onApplyMessageInput(e) {
    this.setData({ applyMessage: e.detail.value })
  },

  async onApply() {
    if (this.data.applying) return
    this.setData({ applying: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'application',
        data: {
          action: 'apply',
          dealingId: this.data.id,
          message: this.data.applyMessage
        }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: '已申请，等待确认', icon: 'success' })
        this.loadDetail()
      } else if (r.code === 'NOT_VERIFIED') {
        wx.showModal({
          title: '需要先认证',
          content: '申请前请先完成医院认证',
          showCancel: false,
          success: () => wx.switchTab({ url: '/pages/profile/profile' })
        })
      } else if (r.code === 'CROSS_HOSPITAL') {
        wx.showToast({ title: r.message, icon: 'none' })
      } else {
        wx.showToast({ title: r.message || '申请失败', icon: 'none' })
      }
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '申请失败，请重试', icon: 'none' })
    } finally {
      this.setData({ applying: false })
    }
  },

  async onAccept(e) {
    const applicationId = e.currentTarget.dataset.id
    const confirmRes = await new Promise(resolve => {
      wx.showModal({
        title: '确认人选',
        content: '确认后其他申请人将被拒绝，双方开启站内沟通',
        success: resolve
      })
    })
    if (!confirmRes.confirm) return
    try {
      const res = await wx.cloud.callFunction({
        name: 'application',
        data: { action: 'accept', applicationId }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: '已确认', icon: 'success' })
        this.loadDetail()
      } else {
        wx.showToast({ title: r.message || '确认失败', icon: 'none' })
      }
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '确认失败，请重试', icon: 'none' })
    }
  },

  async onCancelApply() {
    if (!this.data.myApplication) return
    try {
      const res = await wx.cloud.callFunction({
        name: 'application',
        data: { action: 'cancel', applicationId: this.data.myApplication._id }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: '已取消申请', icon: 'success' })
        this.loadDetail()
      } else {
        wx.showToast({ title: r.message || '取消失败', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '取消失败', icon: 'none' })
    }
  }
})
