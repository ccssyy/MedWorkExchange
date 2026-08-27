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
    // 编辑弹层
    editOpen: false,
    editTitle: '',
    editDetail: '',
    editFee: '',
    editStartDate: '',
    editStartTime: '',
    editEndDate: '',
    editEndTime: '',
    editSaving: false,
    canEdit: false,
    categoryLabelMap: {
      shift: '值班',
      case_guide: '病例指导'
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
      // 编辑可用性：本人 + published/applied 状态
      const canEdit = !!r.isOwner && ['published', 'applied'].includes(dealing.status)
      // 履约操作区：撮合双方 + confirmed/in_progress/completed 状态
      const isAcceptedParty = !!r.isAcceptedParty
      const canOperateFlow = (r.isOwner || isAcceptedParty) &&
        ['confirmed', 'in_progress', 'completed'].includes(dealing.status)
      this.setData({
        dealing,
        isOwner: !!r.isOwner,
        crossHospital: !!r.crossHospital,
        applications: r.applications || [],
        myApplication: r.myApplication || null,
        canEdit,
        canOperateFlow,
        myCompleteRequested: !r.isOwner && isAcceptedParty && !!dealing.completeRequested,
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
  },

  // ── 履约流程 ──
  async onStartService() {
    const confirmRes = await new Promise(resolve => {
      wx.showModal({ title: '开始履约', content: '确认已开始履约？', success: resolve })
    })
    if (!confirmRes.confirm) return
    try {
      const res = await wx.cloud.callFunction({
        name: 'dealing',
        data: { action: 'startService', dealingId: this.data.id }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: '已开始履约', icon: 'success' })
        this.loadDetail()
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  async onCompleteService() {
    const isOwner = this.data.isOwner
    const confirmRes = await new Promise(resolve => {
      wx.showModal({
        title: isOwner ? '确认完成' : '申请确认完成',
        content: isOwner ? '确认对方已履约完成？酬金请线下结清' : '向发布方提交完成申请，核实后由发布方确认',
        success: resolve
      })
    })
    if (!confirmRes.confirm) return
    try {
      const res = await wx.cloud.callFunction({
        name: 'dealing',
        data: { action: 'completeService', dealingId: this.data.id }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: r.completed ? '已完成' : '已提交申请', icon: 'success' })
        this.loadDetail()
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  async onConfirmComplete() {
    const confirmRes = await new Promise(resolve => {
      wx.showModal({ title: '确认完成', content: '确认对方已履约完成？', success: resolve })
    })
    if (!confirmRes.confirm) return
    try {
      const res = await wx.cloud.callFunction({
        name: 'dealing',
        data: { action: 'confirmComplete', dealingId: this.data.id }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: '已完成', icon: 'success' })
        this.loadDetail()
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // ── 编辑弹层 ──
  onEditTap() {
    const d = this.data.dealing
    if (!d) return
    const s = d.startTime ? new Date(d.startTime) : null
    const e = d.endTime ? new Date(d.endTime) : null
    const pad = n => String(n).padStart(2, '0')
    const dpart = x => x ? `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}` : ''
    const tpart = x => x ? `${pad(x.getHours())}:${pad(x.getMinutes())}` : '08:00'
    this.setData({
      editOpen: true,
      editTitle: d.title,
      editDetail: d.detail || '',
      editFee: d.fee != null ? String(d.fee) : '',
      editStartDate: s ? dpart(s) : '',
      editStartTime: s ? tpart(s) : '08:00',
      editEndDate: e ? dpart(e) : '',
      editEndTime: e ? tpart(e) : '18:00'
    })
  },

  onEditClose() { this.setData({ editOpen: false }) },
  onEditNoop() {},
  onEditTitleInput(e) { this.setData({ editTitle: e.detail.value }) },
  onEditDetailInput(e) { this.setData({ editDetail: e.detail.value }) },
  onEditFeeInput(e) { this.setData({ editFee: e.detail.value }) },
  onEditStartDateChange(e) { this.setData({ editStartDate: e.detail.value }) },
  onEditStartTimeChange(e) { this.setData({ editStartTime: e.detail.value }) },
  onEditEndDateChange(e) { this.setData({ editEndDate: e.detail.value }) },
  onEditEndTimeChange(e) { this.setData({ editEndTime: e.detail.value }) },

  async onEditSave() {
    if (this.data.editSaving) return
    const { editTitle, editDetail, editFee, editStartDate, editStartTime, editEndDate, editEndTime } = this.data
    if (!editTitle.trim()) return wx.showToast({ title: '标题不能为空', icon: 'none' })
    const startIso = editStartDate ? `${editStartDate}T${editStartTime}:00` : null
    const endIso = editEndDate ? `${editEndDate}T${editEndTime}:00` : null
    if (startIso && endIso && new Date(endIso) <= new Date(startIso)) {
      return wx.showToast({ title: '结束时间需晚于开始时间', icon: 'none' })
    }
    this.setData({ editSaving: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'dealing',
        data: {
          action: 'update',
          dealingId: this.data.id,
          title: editTitle.trim(),
          detail: editDetail.trim(),
          fee: editFee ? Number(editFee) : null,
          startTime: startIso,
          endTime: endIso
        }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: '已保存', icon: 'success' })
        this.setData({ editOpen: false })
        this.loadDetail()
      } else if (r.code === 'RISK_CONTENT' || r.code === 'RISK_PRIVACY') {
        wx.showModal({ title: '内容未通过审核', content: r.message, showCancel: false })
      } else {
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
      }
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ editSaving: false })
    }
  },

  // ── 下架 ──
  async onOffShelfTap() {
    const confirmRes = await new Promise(resolve => {
      wx.showModal({
        title: '下架撮合单',
        content: '下架后列表不再展示，待处理申请将自动拒绝。确认下架？',
        success: resolve
      })
    })
    if (!confirmRes.confirm) return
    try {
      const res = await wx.cloud.callFunction({
        name: 'dealing',
        data: { action: 'offShelf', dealingId: this.data.id }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: '已下架', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 700)
      } else {
        wx.showToast({ title: r.message || '下架失败', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '下架失败', icon: 'none' })
    }
  }
})
