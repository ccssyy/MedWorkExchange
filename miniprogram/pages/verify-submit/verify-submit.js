// 医务认证提交页：选身份 → 选医院 → 传材料（+学信网验证码选填）→ OCR 预审/人工队列
const app = getApp()
const db = wx.cloud.database()

// 角色材料要求（与服务端 verify 云函数 ROLE_TYPES 对应）
const ROLE_OPTIONS = [
  { key: 'student', label: '在校学生', hint: '学生证 + 轮转表/实习手册（能看出轮转医院）', required: 2 },
  { key: 'trainee', label: '规培/实习生', hint: '医院实习胸牌或实习证明（含医院名称）', required: 1 },
  { key: 'doctor', label: '医生', hint: '执业证或工牌照片（含医院名称）', required: 1 }
]

Page({
  data: {
    roleIndex: -1,
    roleOptions: ROLE_OPTIONS.map(r => r.label),
    roleHints: ROLE_OPTIONS.map(r => r.hint),
    hospitals: [],
    hospitalIndex: -1,
    files: [],           // { fileID }
    maxFiles: 3,
    chsiCode: '',        // 学信网验证码（接口预留，选填）
    myStatus: null,      // none/pending/verified/rejected
    rejectReason: '',
    submitting: false,
    uploading: false
  },

  onLoad() {
    this.loadMyVerify()
    this.loadHospitals()
  },

  loadMyVerify() {
    wx.cloud.callFunction({
      name: 'verify',
      data: { action: 'myVerify' }
    }).then(res => {
      const r = res.result || {}
      if (r.ok) {
        this.setData({
          myStatus: r.status,
          rejectReason: r.rejectReason || '',
          roleIndex: r.roleType ? ROLE_OPTIONS.findIndex(x => x.key === r.roleType) : -1
        })
      }
    }).catch(() => {})
  },

  loadHospitals() {
    wx.cloud.callFunction({
      name: 'hospital',
      data: { action: 'list' }
    }).then(res => {
      const hospitals = (res.result && res.result.hospitals) || []
      this.setData({
        hospitals,
        hospitalNames: hospitals.map(h => `${h.name}（${h.city}）`)
      })
    })
  },

  onRoleChange(e) {
    this.setData({ roleIndex: Number(e.detail.value) })
  },

  onHospitalChange(e) {
    this.setData({ hospitalIndex: Number(e.detail.value) })
  },

  onChsiInput(e) {
    this.setData({ chsiCode: e.detail.value })
  },

  // 拍照/选图上传
  onAddImage() {
    const remain = this.data.maxFiles - this.data.files.length
    if (remain <= 0) return wx.showToast({ title: '最多 3 张', icon: 'none' })
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: res => {
        this.setData({ uploading: true })
        Promise.all(res.tempFiles.map(f => new Promise((resolve, reject) => {
          wx.cloud.uploadFile({
            cloudPath: `verify_materials/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
            filePath: f.tempFilePath,
            success: r => resolve(r.fileID),
            fail: reject
          })
        }))).then(fileIDs => {
          this.setData({
            files: this.data.files.concat(fileIDs.map(id => ({ fileID: id }))),
            uploading: false
          })
        }).catch(() => {
          this.setData({ uploading: false })
          wx.showToast({ title: '上传失败，请重试', icon: 'none' })
        })
      }
    })
  },

  onRemoveImage(e) {
    const idx = e.currentTarget.dataset.index
    this.setData({ files: this.data.files.filter((_, i) => i !== idx) })
  },

  onPreview(e) {
    const idx = e.currentTarget.dataset.index
    wx.previewImage({
      current: this.data.files[idx].fileID,
      urls: this.data.files.map(f => f.fileID)
    })
  },

  async onSubmit() {
    if (this.data.submitting) return
    const { roleIndex, hospitalIndex, files, chsiCode } = this.data
    if (roleIndex < 0) return wx.showToast({ title: '请选择申请身份', icon: 'none' })
    if (hospitalIndex < 0) return wx.showToast({ title: '请选择医院', icon: 'none' })
    const role = ROLE_OPTIONS[roleIndex]
    if (files.length < role.required) {
      return wx.showToast({ title: `该身份至少上传 ${role.required} 张材料`, icon: 'none' })
    }
    this.setData({ submitting: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'verify',
        data: {
          action: 'submitVerify',
          roleType: role.key,
          hospitalId: this.data.hospitals[hospitalIndex]._id,
          materials: files,
          chsiCode: chsiCode.trim()
        }
      })
      const r = res.result || {}
      if (r.ok) {
        wx.showModal({
          title: r.autoVerified ? '认证通过' : '已提交',
          content: r.message,
          showCancel: false,
          success: () => {
            if (r.autoVerified) wx.navigateBack()
            else this.loadMyVerify()
          }
        })
      } else {
        wx.showToast({ title: r.message || '提交失败', icon: 'none' })
      }
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '提交失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
