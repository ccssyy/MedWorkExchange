// ══════════════════════════════════════════════════════════════
// 订阅消息授权征集（客户端）
//
// 两个硬约束决定了这里的写法：
//
//  1) wx.requestSubscribeMessage 必须在**用户手势的同步调用栈**中发起。
//     一旦 await 了前置逻辑（包括网络请求），手势上下文就丢了，会报
//     "can only be invoked by user TAP gesture"。所以模板 ID 必须**提前缓存**，
//     在 tap 里直接读缓存同步调用 —— 这就是 prefetch() 存在的理由。
//
//  2) 一次订阅 = 一次下发额度。授权归「当前用户」，因此征集时机是
//     “用户自己做某个操作时，顺手为自己后续要收的那类通知授权”。
//     例：A 发消息时为自己授权「新私信」→ 服务端之后才能给 A 推私信通知。
//
// 全部失败路径静默降级：模板未配置、用户拒绝、接口报错，都不能影响主流程。
// ══════════════════════════════════════════════════════════════

const CACHE_KEY = 'mwe_subscribe_ids'
const MAX_PER_CALL = 3 // 微信单次最多 3 个模板 ID

let memIds = null

function getCachedIds() {
  if (memIds) return memIds
  try {
    memIds = wx.getStorageSync(CACHE_KEY) || {}
  } catch (e) {
    memIds = {}
  }
  return memIds
}

// 启动时预取模板 ID（app.onLaunch 调用）。失败不重试、不阻塞启动。
function prefetch() {
  return wx.cloud.callFunction({
    name: 'notify',
    data: { action: 'templates' }
  }).then(res => {
    const ids = (res.result && res.result.ids) || {}
    memIds = ids
    try { wx.setStorageSync(CACHE_KEY, ids) } catch (e) { /* 存储失败仅影响下次启动 */ }
    return ids
  }).catch(() => getCachedIds())
}

/**
 * 在 tap 事件处理函数中**同步**调用（不要放在 await 之后）。
 * @param {string[]} keys 模板 key，如 ['applicationResult']
 * @returns {Promise<{accepted:string[], result:object}|{skipped?:string, error?:object}>}
 */
function request(keys) {
  const ids = getCachedIds()
  const tmplIds = (keys || []).map(k => ids[k]).filter(Boolean).slice(0, MAX_PER_CALL)

  // 未配置模板（或尚未预取到）→ 直接跳过，不打扰用户
  if (!tmplIds.length) return Promise.resolve({ skipped: 'no_template', accepted: [] })

  return new Promise(resolve => {
    try {
      wx.requestSubscribeMessage({
        tmplIds,
        success: res => {
          const accepted = tmplIds.filter(id => res[id] === 'accept')
          resolve({ accepted, result: res })
        },
        fail: err => {
          // 用户关闭了订阅主开关 / 模板 ID 无效等，均不影响主流程
          console.warn('[subscribe] request failed', err)
          resolve({ accepted: [], error: err })
        }
      })
    } catch (e) {
      console.warn('[subscribe] request threw', e)
      resolve({ accepted: [], error: e })
    }
  })
}

// 模板 key 常量：与服务端 cloudfunctions/notify/templates.js 的 key 一一对应
const KEYS = {
  NEW_APPLICATION: 'newApplication',        // 发布方：收到新申请
  APPLICATION_RESULT: 'applicationResult',  // 申请方：申请结果
  NEW_MESSAGE: 'newMessage',                // 收信方：新私信
  SERVICE_REMINDER: 'serviceReminder',      // 双方：履约待确认提醒
  SERVICE_AUTO_COMPLETED: 'serviceAutoCompleted', // 双方：系统自动确认完成
  REPORT_RESULT: 'reportResult'             // 举报人：举报处理结果
}

module.exports = { prefetch, request, getCachedIds, KEYS }
