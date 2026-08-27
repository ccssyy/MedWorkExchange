const app = getApp()

const SORTS = [
  { key: 'latest', label: '最新发布' },
  { key: 'fee_asc', label: '价格低到高' },
  { key: 'fee_desc', label: '价格高到低' },
  { key: 'time_near', label: '时间临近' }
]
const TIMES = [
  { key: '', label: '全部时间' },
  { key: '1', label: '近24小时' },
  { key: '7', label: '近7天' },
  { key: '30', label: '近30天' }
]
const FEES = [
  { key: '', label: '全部价格' },
  { key: 'free', label: '面议' },
  { key: '0-100', label: '￥0-100' },
  { key: '100-300', label: '￥100-300' },
  { key: '300+', label: '￥300以上' }
]

Page({
  data: {
    keyword: '',
    sortIndex: 0,
    categoryIndex: 0,
    deptIndex: 0,
    timeIndex: 0,
    feeIndex: 0,
    sorts: SORTS,
    categories: [
      { key: '', label: '全部类型' },
      { key: 'shift', label: '值班' },
      { key: 'case_guide', label: '病例指导' }
    ],
    times: TIMES,
    fees: FEES,
    departments: ['全部科室'],
    // 筛选抽屉
    drawerOpen: false,
    hospitalKeyword: '',
    hospitalResults: [],
    selectedHospital: null,   // { _id, name }
    browsingLabel: '本院',
    dealings: [],
    loading: true,
    categoryLabelMap: { shift: '值班', case_guide: '病例指导' },
    statusLabelMap: {
      published: '待接单', applied: '申请中', confirmed: '已确认',
      in_progress: '履约中', completed: '已完成', cancelled: '已取消', disputed: '争议中'
    }
  },

  onLoad() {
    this.loadDepartments()
    this.loadDealings()
  },

  onShow() {
    if (this._needRefresh) this.loadDealings()
  },

  loadDepartments() {
    wx.cloud.callFunction({
      name: 'hospital',
      data: { action: 'list' }
    }).then(res => {
      const hospitals = (res.result && res.result.hospitals) || []
      if (hospitals.length && !app.globalData.browsingHospitalId) {
        app.globalData.browsingHospitalId = hospitals[0]._id
      }
    })
    // 科室字典：Pilot 端内置（configs 集合同步维护，量小直接本地）
    const depts = ['全部科室', '内科', '外科', '妇产科', '儿科', '急诊科', '重症医学科', '麻醉科',
      '心内科', '呼吸内科', '消化内科', '神经内科', '肾内科', '内分泌科',
      '骨科', '神经外科', '心胸外科', '泌尿外科', '普外科',
      '精神科', '皮肤科', '眼科', '耳鼻喉科', '口腔科', '放射科', '超声科', '检验科', '病理科',
      '肿瘤科', '康复科', '全科', '其他']
    this.setData({ departments: depts })
  },

  // ── 筛选交互 ──
  onSearchInput(e) { this.setData({ keyword: e.detail.value }) },
  onSearchConfirm() { this.loadDealings() },
  onSortChange(e) { this.setData({ sortIndex: Number(e.detail.value) }); this.loadDealings() },
  onCategoryChange(e) { this.setData({ categoryIndex: Number(e.detail.value) }); this.loadDealings() },
  onDeptChange(e) { this.setData({ deptIndex: Number(e.detail.value) }); this.loadDealings() },
  onTimeChange(e) { this.setData({ timeIndex: Number(e.detail.value) }); this.loadDealings() },
  onFeeChange(e) { this.setData({ feeIndex: Number(e.detail.value) }); this.loadDealings() },

  openDrawer() { this.setData({ drawerOpen: true }) },
  closeDrawer() { this.setData({ drawerOpen: false }) },
  noop() {},

  onHospitalKeywordInput(e) {
    const keyword = e.detail.value
    this.setData({ hospitalKeyword: keyword })
    if (!keyword.trim()) { this.setData({ hospitalResults: [] }); return }
    wx.cloud.callFunction({
      name: 'hospital',
      data: { action: 'search', keyword }
    }).then(res => {
      this.setData({ hospitalResults: (res.result && res.result.hospitals) || [] })
    })
  },

  onPickHospital(e) {
    const h = this.data.hospitalResults[e.currentTarget.dataset.index]
    this.setData({
      selectedHospital: h,
      hospitalResults: [],
      hospitalKeyword: '',
      browsingLabel: h.name,
      drawerOpen: false
    })
    this.loadDealings()
  },

  clearHospital() {
    this.setData({ selectedHospital: null, browsingLabel: '本院' })
    this.loadDealings()
  },

  // ── 数据加载 ──
  loadDealings() {
    this._needRefresh = true
    const { keyword, sortIndex, categoryIndex, deptIndex, timeIndex, feeIndex,
      categories, departments, times, fees, selectedHospital } = this.data
    this.setData({ loading: true })
    const payload = {
      action: 'list',
      keyword: keyword || undefined,
      sort: SORTS[sortIndex].key,
      category: categories[categoryIndex].key || undefined,
      department: deptIndex > 0 ? departments[deptIndex] : undefined,
      hospitalId: selectedHospital ? selectedHospital._id : undefined,
      days: times[timeIndex].key || undefined
    }
    const fee = fees[feeIndex].key
    if (fee === 'free') payload.feeMax = 0
    else if (fee === '0-100') { payload.feeMin = 0; payload.feeMax = 100 }
    else if (fee === '100-300') { payload.feeMin = 100; payload.feeMax = 300 }
    else if (fee === '300+') payload.feeMin = 300
    // 时间筛选：近 N 天（按发布时间）
    if (payload.days) payload.timeFrom = new Date(Date.now() - Number(payload.days) * 86400000).toISOString()

    wx.cloud.callFunction({ name: 'dealing', data: payload }).then(res => {
      const { dealings = [] } = res.result || {}
      dealings.forEach(d => {
        d.categoryLabel = this.data.categoryLabelMap[d.category] || d.category
        d.statusLabel = this.data.statusLabelMap[d.status] || d.status
        d.feeLabel = d.fee != null ? `￥${d.fee}` : '面议'
        d.hospitalShort = d.hospitalName || ''
      })
      this.setData({ dealings, loading: false })
    }).catch(err => {
      console.error(err)
      this.setData({ loading: false })
    })
  },

  onDealingTap(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` })
  },

  onFabTap() {
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  onPullDownRefresh() {
    this.loadDealings()
    wx.stopPullDownRefresh()
  }
})
