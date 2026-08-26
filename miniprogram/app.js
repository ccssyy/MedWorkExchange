App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低，请升级至 2.2.3 以上以使用云开发能力')
    } else {
      wx.cloud.init({
        // env 由环境初始化时填入，格式：环境ID（云开发控制台获取）
        env: this.globalData.cloudEnv,
        traceUser: true
      })
      this.ensureUser()
    }
  },

  // 启动即建档/拉取用户档案（login 云函数 ensure：无则建、有则返回）
  ensureUser() {
    wx.cloud.callFunction({
      name: 'login',
      data: { action: 'ensure' }
    }).then(res => {
      const user = (res.result && res.result.user) || null
      this.globalData.userInfo = user
    }).catch(err => {
      console.error('建档失败', err)
    })
  },

  globalData: {
    // 云开发环境 ID：部署时在云开发控制台创建环境后填入
    cloudEnv: 'cloud1-d9gwlepe0f2e51cb8',
    userInfo: null,
    // 当前浏览的医院（跨院透明浏览用），写操作一律以服务端 user.hospital_id 为准
    browsingHospitalId: null
  }
})
