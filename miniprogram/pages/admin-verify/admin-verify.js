// 管理员认证审核页：待审列表 + 材料大图 + 通过/驳回 + 学信网输码核验指引
Page({
  data: {
    list: [],
    loading: true,
    isAdmin: false
  },

  onLoad() {
    this.loadList()
  },

  onShow() {
    if (this.data.isAdmin) this.loadList()
  },

  loadList() {
    wx.cloud.callFunction({
      name: 'verify',
      data: { action: 'adminVerifyList' }
    }).then(res => {
      const r = res.result || {}
      if (r.ok) {
        this.setData({ list: r.list || [], loading: false, isAdmin: true })
      } else if (r.code === 'FORBIDDEN') {
        this.setData({ loading: false, isAdmin: false })
      } else {
        this.setData({ loading: false })
        wx.showToast({ title: r.message || '加载失败', icon: 'none' })
      }
    }).catch(() => this.setData({ loading: false }))
  },

  onPreview(e) {
    const { uid, index } = e.currentTarget.dataset
    const item = this.data.list.find(x => x.uid === uid)
    if (!item || !item.files.length) return
    wx.previewImage({ current: item.files[index], urls: item.files })
  },

  async onApprove(e) {
    const uid = e.currentTarget.dataset.uid
    const confirmRes = await new Promise(resolve => {
      wx.showModal({
        title: '通过认证',
        content: '确认材料核对无误？通过后用户即可发布与接单。',
        success: resolve
      })
    })
    if (!confirmRes.confirm) return
    const res = await wx.cloud.callFunction({
      name: 'verify',
      data: { action: 'adminVerify', uid, verdict: 'approve' }
    }).catch(() => null)
    const r = res && res.result
    if (r && r.ok) {
      wx.showToast({ title: '已通过', icon: 'success' })
      this.loadList()
    } else {
      wx.showToast({ title: (r && r.message) || '操作失败', icon: 'none' })
    }
  },

  async onReject(e) {
    const uid = e.currentTarget.dataset.uid
    const input = await new Promise(resolve => {
      wx.showModal({
        title: '驳回申请',
        content: '',
        editable: true,
        placeholderText: '必填：如「照片模糊」「医院不一致」',
        success: resolve,
        fail: () => resolve({ confirm: false })
      })
    })
    if (!input.confirm) return
    const reason = (input.content || '').trim()
    if (!reason) return wx.showToast({ title: '需填写驳回理由', icon: 'none' })
    const res = await wx.cloud.callFunction({
      name: 'verify',
      data: { action: 'adminVerify', uid, verdict: 'reject', reason }
    }).catch(() => null)
    const r = res && res.result
    if (r && r.ok) {
      wx.showToast({ title: '已驳回', icon: 'success' })
      this.loadList()
    } else {
      wx.showToast({ title: (r && r.message) || '操作失败', icon: 'none' })
    }
  },

  // 抽检撤销（已通过者发现材料伪造）
  async onRevoke(e) {
    const uid = e.currentTarget.dataset.uid
    const input = await new Promise(resolve => {
      wx.showModal({
        title: '撤销认证',
        content: '',
        editable: true,
        placeholderText: '撤销理由（默认：复核未通过），同时扣 20 信用分',
        success: resolve,
        fail: () => resolve({ confirm: false })
      })
    })
    if (!input.confirm) return
    const res = await wx.cloud.callFunction({
      name: 'verify',
      data: { action: 'adminVerify', uid, verdict: 'revoke', reason: (input.content || '').trim() }
    }).catch(() => null)
    const r = res && res.result
    if (r && r.ok) {
      wx.showToast({ title: '已撤销', icon: 'success' })
    } else {
      wx.showToast({ title: (r && r.message) || '操作失败', icon: 'none' })
    }
  }
})
