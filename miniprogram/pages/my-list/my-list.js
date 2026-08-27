Page({
  data: {
    role: 'owner',
    list: [],
    loading: true,
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
    },
    applyStatusLabelMap: {
      pending: '等待确认',
      accepted: '已通过',
      rejected: '未通过',
      cancelled: '已取消'
    }
  },

  onLoad(options) {
    this.setData({ role: options.role === 'applicant' ? 'applicant' : 'owner' })
    wx.setNavigationBarTitle({ title: this.data.role === 'applicant' ? '我的申请' : '我的发布' })
    this.loadList()
  },

  loadList() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'dealing',
      data: { action: 'mine', role: this.data.role }
    }).then(res => {
      const { list = [] } = res.result || {}
      list.forEach(x => {
        x.categoryLabel = this.data.categoryLabelMap[x.category] || x.category
        x.statusLabel = this.data.statusLabelMap[x.status] || x.status
        x.applyStatusLabel = x.applicationStatus
          ? (this.data.applyStatusLabelMap[x.applicationStatus] || x.applicationStatus)
          : ''
        x.feeLabel = x.fee ? `酬金 ${x.fee} 元` : '面议'
      })
      this.setData({ list, loading: false })
    }).catch(err => {
      console.error(err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
  },

  onPullDownRefresh() {
    this.loadList()
    wx.stopPullDownRefresh()
  }
})
