const app = getApp()

Page({
  data: {
    categories: [
      { key: 'shift', label: '值班' },
      { key: 'case_guide', label: '病例指导' },
      { key: 'escort', label: '陪诊' }
    ],
    categoryIndex: 0,
    // 默认值：用户档案（认证医院/科室），可改科室
    isPatient: false,
    defaultHospital: '',
    departments: [],
    deptIndex: 0,
    // 起止时间：日期与时间分开存，提交时拼接（避免字符串截取 bug）
    startDate: '2026-08-28',
    startTime: '18:00',
    endDate: '2026-08-29',
    endTime: '08:00',
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
      // 患者角色：仅陪诊需求单，科室隐藏
      const isPatient = !!(user && user.isPatient)
      const patch = {
        defaultHospital: user ? (user.hospitalName || (isPatient ? '患者/家属' : '未认证')) : '未登录',
        departments: depts,
        deptIndex: deptIdx,
        isPatient
      }
      if (isPatient) {
        patch.categories = [{ key: 'escort', label: '陪诊' }]
        patch.categoryIndex = 0
      }
      this.setData(patch)
    })
  },

  onCategoryChange(e) { this.setData({ categoryIndex: Number(e.detail.value) }) },
  onDeptChange(e) { this.setData({ deptIndex: Number(e.detail.value) }) },

  // 日期时间选择：日期与时间独立 picker，各自更新
  onStartDateChange(e) { this.setData({ startDate: e.detail.value }) },
  onStartTimeChange(e) { this.setData({ startTime: e.detail.value }) },
  onEndDateChange(e) { this.setData({ endDate: e.detail.value }) },
  onEndTimeChange(e) { this.setData({ endTime: e.detail.value }) },

  onTitleInput(e) { this.setData({ title: e.detail.value }) },
  onDetailInput(e) { this.setData({ detail: e.detail.value }) },
  onFeeInput(e) { this.setData({ fee: e.detail.value }) },

  async onSubmit() {
    const { categories, categoryIndex, title, detail, fee, startDate, startTime, endDate, endTime } = this.data
    if (!title.trim()) {
      return wx.showToast({ title: '请填写标题', icon: 'none' })
    }
    const user = app.globalData.userInfo
    const isPatient = !!(user && user.isPatient)
    if (!user || (!isPatient && user.verifyStatus !== 'verified')) {
      return wx.showModal({
        title: isPatient ? '需要激活患者身份' : '需要先认证',
        content: isPatient ? '发布陪诊需求前请先完成患者身份激活（我的-身份认证）' : '发布前请先完成医院认证（我的-身份认证）',
        showCancel: false,
        success: () => wx.switchTab({ url: '/pages/profile/profile' })
      })
    }
    // 拼接 ISO 时间：日期 + T + 时分 + :00 秒（iOS/Android 双端安全格式）
    const startIso = `${startDate}T${startTime}:00`
    const endIso = `${endDate}T${endTime}:00`
    const startT = new Date(startIso)
    const endT = new Date(endIso)
    if (isNaN(startT.getTime()) || isNaN(endT.getTime())) {
      return wx.showToast({ title: '请选择完整的起止时间', icon: 'none' })
    }
    if (endT <= startT) {
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
