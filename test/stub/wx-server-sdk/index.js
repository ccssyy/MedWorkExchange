// ══════════════════════════════════════════════════════════════
// 最小 wx-server-sdk 桩 —— 供 timer / notify 云函数的离线逻辑验证使用
// 通过 NODE_PATH 指向 test/stub 生效（仓库内无 node_modules，故桩必定被命中）
//
// 支持：where 等值 / _.in / _.lte / _.lt / _.gte / _.neq / _.exists
//       / _.and / _.or、skip / limit / orderBy / get / count / update / add / doc
//       cloud.openapi.subscribeMessage.send（可编程失败，用于验证错误分支）
//
// 注意：这不是通用 SDK 模拟器。新增云函数若要复用，需先补所需能力。
// ══════════════════════════════════════════════════════════════

const collections = Object.create(null)
let sendCalls = []
let sendBehavior = null
let seq = 0

function ensure(name) {
  if (!collections[name]) collections[name] = []
  return collections[name]
}

function getPath(doc, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc)
}

function setPath(doc, path, val) {
  const parts = path.split('.')
  const last = parts.pop()
  let cur = doc
  for (const p of parts) {
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p]
  }
  cur[last] = val
}

function cmpTime(a, b) {
  return new Date(a).getTime() - new Date(b).getTime()
}

function matchDoc(doc, filter) {
  if (!filter) return true
  if (filter.$logic === 'and') return filter.v.every(f => matchDoc(doc, f))
  if (filter.$logic === 'or') return filter.v.some(f => matchDoc(doc, f))
  for (const key of Object.keys(filter)) {
    const cond = filter[key]
    const val = getPath(doc, key)
    if (cond && typeof cond === 'object' && cond.$op) {
      switch (cond.$op) {
        case 'lte': if (val == null || !(cmpTime(val, cond.v) <= 0)) return false; break
        case 'lt': if (val == null || !(cmpTime(val, cond.v) < 0)) return false; break
        case 'gte': if (val == null || !(cmpTime(val, cond.v) >= 0)) return false; break
        case 'gt': if (val == null || !(cmpTime(val, cond.v) > 0)) return false; break
        case 'in': if (!cond.v.includes(val)) return false; break
        case 'neq': if (val === cond.v) return false; break
        case 'exists': if ((val !== undefined) !== !!cond.v) return false; break
        default: throw new Error('stub: unsupported op ' + cond.$op)
      }
    } else if (val !== cond) {
      return false
    }
  }
  return true
}

function applyUpdate(doc, data) {
  for (const key of Object.keys(data)) {
    const v = data[key]
    if (v && typeof v === 'object' && v.$op === 'inc') {
      setPath(doc, key, (getPath(doc, key) || 0) + v.v)
    } else {
      setPath(doc, key, v)
    }
  }
}

function newId() {
  seq += 1
  return 'id_' + String(seq).padStart(4, '0')
}

function makeQuery(name, filter, skipN, limitN, order) {
  const docs = ensure(name)
  return {
    where(f) { return makeQuery(name, f, skipN, limitN, order) },
    skip(n) { return makeQuery(name, filter, n, limitN, order) },
    limit(n) { return makeQuery(name, filter, skipN, n, order) },
    orderBy(field, dir) { return makeQuery(name, filter, skipN, limitN, { field, dir }) },
    _rows() {
      let hit = docs.filter(d => matchDoc(d, filter))
      if (order) {
        const sign = order.dir === 'desc' ? -1 : 1
        hit = hit.slice().sort((a, b) => sign * (cmpTime(getPath(a, order.field), getPath(b, order.field)) || 0))
      }
      const from = skipN || 0
      return hit.slice(from, from + (limitN == null ? 100 : limitN))
    },
    async get() {
      return { data: this._rows().map(d => ({ ...d })) }
    },
    async count() {
      return { total: docs.filter(d => matchDoc(d, filter)).length }
    },
    async update({ data }) {
      const hit = docs.filter(d => matchDoc(d, filter))
      hit.forEach(d => applyUpdate(d, data))
      return { stats: { updated: hit.length } }
    },
    async add({ data }) {
      const _id = data._id || newId()
      docs.push({ ...data, _id })
      return { _id }
    },
    doc(id) {
      return {
        async get() {
          const d = docs.find(x => x._id === id)
          if (!d) throw new Error('doc not found: ' + id)
          return { data: { ...d } }
        },
        async update({ data }) {
          const d = docs.find(x => x._id === id)
          if (!d) return { stats: { updated: 0 } }
          applyUpdate(d, data)
          return { stats: { updated: 1 } }
        }
      }
    }
  }
}

const command = {
  lte: v => ({ $op: 'lte', v }),
  lt: v => ({ $op: 'lt', v }),
  gte: v => ({ $op: 'gte', v }),
  gt: v => ({ $op: 'gt', v }),
  in: arr => ({ $op: 'in', v: arr }),
  neq: v => ({ $op: 'neq', v }),
  exists: b => ({ $op: 'exists', v: b }),
  inc: n => ({ $op: 'inc', v: n }),
  and: arr => ({ $logic: 'and', v: arr }),
  or: arr => ({ $logic: 'or', v: arr })
}

const db = {
  command,
  collection: name => makeQuery(name, null, 0, null, null)
}

const openapi = {
  subscribeMessage: {
    async send(payload) {
      sendCalls.push({ ...payload })
      if (sendBehavior) {
        const thrown = sendBehavior(payload, sendCalls.length)
        if (thrown) throw thrown
      }
      return { errCode: 0, errMsg: 'ok' }
    }
  }
}

module.exports = {
  init() {},
  database: () => db,
  getWXContext: () => ({ OPENID: 'stub-openid' }),
  openapi,
  // 测试辅助（真实 SDK 无此成员）
  __store: {
    reset() {
      Object.keys(collections).forEach(k => delete collections[k])
      sendCalls = []
      sendBehavior = null
      seq = 0
    },
    seed(name, rows) {
      const c = ensure(name)
      rows.forEach(r => c.push({ ...r }))
    },
    all(name) {
      return ensure(name)
    },
    sendCalls() {
      return sendCalls
    },
    // fn(payload, n) 返回一个 Error 则抛出；返回 null/undefined 视为成功
    setSendBehavior(fn) {
      sendBehavior = fn
    }
  }
}
