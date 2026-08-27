const app = getApp()

const TOPICS = [
  { key: '', label: '全部' },
  { key: 'gp_experience', label: '规培心得' },
  { key: 'case_discussion', label: '病例讨论' },
  { key: 'help', label: '求助提问' },
  { key: 'experience', label: '经验分享' },
  { key: 'exam', label: '考研考博' },
  { key: 'recruit', label: '招聘信息' },
  { key: 'chat', label: '闲聊灌水' }
]
const TIMES = [
  { key: '7', label: '近7天' },
  { key: '30', label: '近30天' },
  { key: '', label: '全部时间' }
]

Page({
  data: {
    topicIndex: 0,
    timeIndex: 0,
    topics: TOPICS,
    times: TIMES,
    posts: [],
    loading: true
  },

  onShow() {
    this.loadPosts()
  },

  onTopicChange(e) {
    this.setData({ topicIndex: Number(e.detail.value) })
    this.loadPosts()
  },

  onTimeChange(e) {
    this.setData({ timeIndex: Number(e.detail.value) })
    this.loadPosts()
  },

  loadPosts() {
    this.setData({ loading: true })
    const { topics, topicIndex, times, timeIndex } = this.data
    wx.cloud.callFunction({
      name: 'posts',
      data: {
        action: 'listPosts',
        topic: topics[topicIndex].key || undefined,
        days: times[timeIndex].key || undefined
      }
    }).then(res => {
      const { posts = [] } = res.result || {}
      this.setData({ posts, loading: false })
    }).catch(err => {
      console.error(err)
      this.setData({ loading: false })
    })
  },

  onPostTap(e) {
    wx.navigateTo({ url: `/pages/post-detail/post-detail?id=${e.currentTarget.dataset.id}` })
  },

  onComposeTap() {
    wx.navigateTo({ url: '/pages/post-publish/post-publish' })
  },

  onPullDownRefresh() {
    this.loadPosts()
    wx.stopPullDownRefresh()
  }
})
