const app = getApp()

Page({
  data: {
    currentHospital: null,
    browsingHospitalName: '选择医院',
    dealings: [],
    loading: true,
    categoryTabs: [
      { key: 'all', label: '全部' },
      { key: 'shift', label: '换班' },
      { key: 'case_guide', label: '病例指导' },
      { key: 'resume_guide', label: '简历指导' }
    ],
    activeCategory: 'all',
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

  onLoad() {
    this.loadHospitals()
  },

  onShow() {
    // 每次显示刷新列表（从发布页返回时同步）
    if (app.globalData.browsingHospitalId) {
      this.loadDealings()
    }
  },

  loadHospitals() {
    wx.cloud.callFunction({
      name: 'hospital',
      data: { action: 'list' }
    }).then(res => {
      const { hospitals } = res.result || {}
      if (hospitals && hospitals.length) {
        const current = hospitals[0]
        app.globalData.browsingHospitalId = current._id
        this.setData({
          currentHospital: current,
          browsingHospitalName: current.name
        })
        this.loadDealings()
      }
    }).catch(err => {
      console.error('加载医院失败', err)
      this.setData({ loading: false })
    })
  },

  onHospitalTap() {
    const names = (this.data.currentHospital ? [this.data.currentHospital] : []).concat()
    wx.cloud.callFunction({
      name: 'hospital',
      data: { action: 'list' }
    }).then(res => {
      const hospitals = (res.result && res.result.hospitals) || []
      if (!hospitals.length) return
      wx.showActionSheet({
        itemList: hospitals.map(h => h.name),
        success: (e) => {
          const picked = hospitals[e.tapIndex]
          app.globalData.browsingHospitalId = picked._id
          this.setData({
            currentHospital: picked,
            browsingHospitalName: picked.name
          })
          this.loadDealings()
        }
      })
    })
  },

  onCategoryTap(e) {
    this.setData({ activeCategory: e.currentTarget.dataset.key })
    this.loadDealings()
  },

  loadDealings() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'dealing',
      data: {
        action: 'list',
        hospitalId: app.globalData.browsingHospitalId,
        category: this.data.activeCategory === 'all' ? undefined : this.data.activeCategory
      }
    }).then(res => {
      const { dealings = [] } = res.result || {}
      dealings.forEach(d => {
        d.categoryLabel = this.data.categoryLabelMap[d.category] || d.category
        d.statusLabel = this.data.statusLabelMap[d.status] || d.status
        d.feeLabel = d.fee ? `酬金 ${d.fee} 元` : '面议'
      })
      this.setData({ dealings, loading: false })
    }).catch(err => {
      console.error('加载撮合单失败', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  onPullDownRefresh() {
    this.loadDealings()
    wx.stopPullDownRefresh()
  },

  onDealingTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
  },

  onFabTap() {
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  goLogin() {
    wx.switchTab({ url: '/pages/profile/profile' })
  }
})
