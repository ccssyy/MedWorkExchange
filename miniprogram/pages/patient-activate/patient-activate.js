// 患者身份激活：微信登录 → 手机号授权 → 实名信息 → role=patient
const app = getApp()

Page({
  data: {
    step: 1,              // 1=手机号授权 2=实名信息
    phone: '',
    realName: '',
    idLast4: '',          // 实名后4位（最小化收集）
    agree: false,
    submitting: false
  },

  onAgreeToggle() {
    this.setData({ agree: !this.data.agree })
  },

  // 手机号快捷授权（button open-type=getPhoneNumber）
  async onGetPhone(e) {
    if (!this.data.agree) {
      return wx.showToast({ title: '请先勾选同意服务须知', icon: 'none' })
    }
    const detail = e.detail || {}
    if (!detail.code) {
      // 用户拒绝授权
      return wx.showToast({ title: '需要手机号完成患者身份登记', icon: 'none' })
    }
    this.setData({ submitting: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'login',
        data: { action: 'bindPatientPhone', phoneCode: detail.code }
      })
      const r = res.result || {}
      if (!r.ok) {
        return wx.showToast({ title: r.message || '手机号绑定失败', icon: 'none' })
      }
      this.setData({ step: 2, phone: r.phoneMasked || '' })
    } catch (err) {
      wx.showToast({ title: '绑定失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  onRealNameInput(e) { this.setData({ realName: e.detail.value }) },
  onIdLast4Input(e) { this.setData({ idLast4: e.detail.value }) },

  async onSubmitRealName() {
    const name = this.data.realName.trim()
    const id4 = this.data.idLast4.trim()
    if (!name) return wx.showToast({ title: '请填写真实姓名', icon: 'none' })
    if (!/^\d{4}$/.test(id4)) return wx.showToast({ title: '请填写身份证后4位', icon: 'none' })
    this.setData({ submitting: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'login',
        data: { action: 'activatePatient', realName: name, idLast4: id4 }
      })
      const r = res.result || {}
      if (r.ok) {
        app.globalData.userInfo = r.user
        wx.showModal({
          title: '患者身份已激活',
          content: '您现在可以发布陪诊需求了。医务内容（病例讨论等）需医院认证后可见。',
          showCancel: false,
          success: () => wx.switchTab({ url: '/pages/index/index' })
        })
      } else {
        wx.showToast({ title: r.message || '激活失败', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: '激活失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
