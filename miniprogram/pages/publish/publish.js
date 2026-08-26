const app = getApp()

Page({
  data: {
    categories: [
      { key: 'shift', label: '值班' },
      { key: 'case_guide', label: '病例指导' }
    ],
    categoryIndex: 0,
    // 默认值：用户档案（认证医院/科室），可改科室
    defaultHospital: '',
    departments: [],
    deptIndex: 0,
    // 起止时间（年月日时分 picker）
    startDate: '2026-01-01 08:00',
    endDate: '2026-01-01 18:00',
    title: '',
    detail: '',
    fee: '',
    submitting: false
  },

  onLoad() {
    this.loadDefaults()
  },

  loadDefaults() {
    wx.cloud.callFunction({
      name: 'login',
      data: { action: 'profile' }
    }).then(res => {
      const user = (res.result && res.result.user) || null
      app.globalData.userInfo = user
      const depts = ['内科', '外科', '妇产科', '儿科', '急诊科', '重症医学科', '麻醉科',
        '心内科', '呼吸内科', '消化内科', '神经内科', '肾内科', '内分泌科',
        '骨科', '神经外科', '心胸外科', '泌尿外科', '普外科',
        '精神科', '皮肤科', '眼科', '耳鼻喉科', '口腔科', '放射科', '超声科', '检验科', '病理科',
        '肿瘤科', '康复科', '全科', '其他']
      const deptIdx = user && user.department ? Math.max(0, depts.indexOf(user.department)) : 0
      this.setData({
        defaultHospital: user ? (user.hospitalName || '未认证') : '未登录',
        departments: depts,
        deptIndex: deptIdx
      })
    })
  },

  onCategoryChange(e) { this.setData({ categoryIndex: Number(e.detail.value) }) },
  onDeptChange(e) { this.setData({ deptIndex: Number(e.detail.value) }) },

  // 日期时间选择：日期 picker + 时间 picker 组合
  onStartDateChange(e) { this.setData({ startDate: e.detail.value }) },
  onStartTimeChange(e) { this.setData({ startDate: this.data.startDate.slice(0, 11) + e.detail.value + ':00' }) },
  onEndDateChange(e) { this.setData({ endDate: e.detail.value }) },
  onEndTimeChange(e) { this.setData({ endDate: this.data.endDate.slice(0, 11) + e.detail.value + ':00' }) },

  onTitleInput(e) { this.setData({ title: e.detail.value }) },
  onDetailInput(e) { this.setData({ detail: e.detail.value }) },
  onFeeInput(e) { this.setData({ fee: e.detail.value }) },

  async onSubmit() {
    const { categories, categoryIndex, title, detail, fee, startDate, endDate } = this.data
    if (!title.trim()) {
      return wx.showToast({ title: '请填写标题', icon: 'none' })
    }
    const user = app.globalData.userInfo
    if (!user || user.verifyStatus !== 'verified') {
      return wx.showModal({
        title: '需要先认证',
        content: '发布前请先完成医院认证（我的-医院认证）',
        showCancel: false,
        success: () => wx.switchTab({ url: '/pages/profile/profile' })
      })
    }
    const startIso = startDate.replace(' ', 'T')
    const endIso = endDate.replace(' ', 'T')
    if (new Date(endIso) <= new Date(startIso)) {
      return wx.showToast({ title: '结束时间需晚于开始时间', icon: 'none' })
    }

    this.setData({ submitting: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'dealing',
        data: {
          action: 'create',
          type: 'requirement',
          category: categories[categoryIndex].key,
          department: this.data.departments[this.data.deptIndex],
          title: title.trim(),
          detail: detail.trim(),
          fee: fee ? Number(fee) : null,
          startTime: startIso,
          endTime: endIso
        }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showToast({ title: '发布成功', icon: 'success' })
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 800)
      } else if (r.code === 'NOT_VERIFIED') {
        wx.showModal({ title: '需要先认证', content: '发布前请先完成医院认证', showCancel: false })
      } else if (r.code === 'RISK_CONTENT') {
        wx.showToast({ title: r.message, icon: 'none' })
      } else {
        wx.showToast({ title: r.message || '发布失败', icon: 'none' })
      }
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '发布失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
