Page({
  data: {
    mode: 'requirement',
    categories: [
      { key: 'shift', label: '换班调班' },
      { key: 'case_guide', label: '病例指导' },
      { key: 'resume_guide', label: '简历指导' }
    ],
    categoryIndex: 0,
    title: '',
    detail: '',
    schedule: '',
    fee: '',
    submitting: false
  },

  onModeChange(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
  },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },

  onTitleInput(e) { this.setData({ title: e.detail.value }) },
  onDetailInput(e) { this.setData({ detail: e.detail.value }) },
  onScheduleInput(e) { this.setData({ schedule: e.detail.value }) },
  onFeeInput(e) { this.setData({ fee: e.detail.value }) },

  async onSubmit() {
    const { mode, categoryIndex, categories, title, detail, schedule, fee } = this.data
    if (!title.trim()) {
      return wx.showToast({ title: '请填写标题', icon: 'none' })
    }
    if (mode === 'requirement' && !schedule.trim()) {
      return wx.showToast({ title: '请填写值班时段', icon: 'none' })
    }
    this.setData({ submitting: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'dealing',
        data: {
          action: 'create',
          type: mode,
          category: categories[categoryIndex].key,
          title: title.trim(),
          detail: detail.trim(),
          schedule: schedule.trim(),
          fee: fee ? Number(fee) : null
        }
      })
      if (res.result && res.result.ok) {
        wx.showToast({ title: '发布成功', icon: 'success' })
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 800)
      } else {
        const msg = (res.result && res.result.message) || '发布失败'
        if (res.result && res.result.code === 'NOT_VERIFIED') {
          wx.showModal({
            title: '需要先认证',
            content: '发布前请先完成医院认证',
            showCancel: false
          })
        } else {
          wx.showToast({ title: msg, icon: 'none' })
        }
      }
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '发布失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
