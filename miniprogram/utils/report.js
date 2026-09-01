// 举报流程公共模块：actionSheet 选原因 → 可选填描述 → report 云函数提交
// 三个入口（撮合单/帖子/私信用户）统一走这里
const REASONS = [
  { key: 'fake', label: '虚假信息' },
  { key: 'illegal', label: '违法违规内容' },
  { key: 'harass', label: '骚扰/辱骂' },
  { key: 'fraud', label: '欺诈行为' },
  { key: 'medical_violation', label: '医疗违规（加号/插队/诊疗行为）' },
  { key: 'other', label: '其他' }
]

/**
 * 发起举报
 * @param {string} targetType 'dealing' | 'post' | 'message' | 'user'
 * @param {string} targetId
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
function reportFlow(targetType, targetId) {
  const labels = REASONS.map(r => r.label)
  return new Promise(resolve => {
    wx.showActionSheet({
      itemList: labels,
      success: async ({ tapIndex }) => {
        const reason = REASONS[tapIndex]
        // 可选补充描述（可取消，取消视为跳过描述直接提交）
        const descRes = await new Promise(r => {
          wx.showModal({
            title: '补充说明（可选）',
            content: '',
            editable: true,
            placeholderText: '补充问题描述，有助于平台核实（200 字内）',
            confirmText: '提交举报',
            cancelText: '跳过',
            success: r,
            fail: () => r({ confirm: false })
          })
        })
        const description = (descRes && descRes.confirm && descRes.content) ? descRes.content.trim() : ''
        try {
          const res = await wx.cloud.callFunction({
            name: 'report',
            data: { action: 'submit', targetType, targetId, reason: reason.key, description }
          })
          const r = res.result || {}
          if (r.ok) {
            wx.showToast({ title: '举报已提交', icon: 'success' })
            resolve({ ok: true })
          } else {
            wx.showToast({ title: r.message || '提交失败', icon: 'none' })
            resolve({ ok: false, message: r.message })
          }
        } catch (err) {
          console.error('report submit error', err)
          wx.showToast({ title: '提交失败，请重试', icon: 'none' })
          resolve({ ok: false, message: '网络错误' })
        }
      },
      fail: () => resolve({ ok: false, message: '已取消' })
    })
  })
}

module.exports = { reportFlow }
