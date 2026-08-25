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
    }
  },
  globalData: {
    // 云开发环境 ID：部署时在云开发控制台创建环境后填入
    cloudEnv: 'REPLACE_WITH_ENV_ID',
    userInfo: null,
    // 当前浏览的医院（跨院透明浏览用），写操作一律以服务端 user.hospital_id 为准
    browsingHospitalId: null
  }
})
