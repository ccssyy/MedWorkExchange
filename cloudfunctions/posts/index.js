const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const TOPICS = ['gp_experience', 'case_discussion', 'help', 'experience', 'exam', 'recruit', 'chat']
// 本地黑名单：运营可扩展，存 configs 集合，启动加载（Pilot 先用内置词）
const LOCAL_BLACKLIST = [
  '法轮功', '赌博', '代开发票', '毒品', '冰毒', '枪支', '买微信号',
  '加微信', '加V', '微信号', '转账到', '刷单', '代办证书'
]
// 患者隐私正则（平台特有：身份证18位/手机号11位）
const PRIVACY_PATTERNS = [
  /\d{17}[\dXx]/,
  /1[3-9]\d{9}/
]

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action

  async function getUser() {
    const found = await db.collection('users').where({ openid: OPENID }).get()
    return found.data[0] || null
  }

  // ════════ 内容安全管线（posts/comments 全走这里）════════
  async function secCheckText(content) {
    const text = String(content || '')
    // 第一道：本地黑名单 + 患者隐私正则
    for (const w of LOCAL_BLACKLIST) {
      if (text.includes(w)) {
        await logAudit(OPENID, 'local_blacklist', text)
        return { ok: false, code: 'RISK_CONTENT', message: `内容含违规词（${mask(w)}），请修改` }
      }
    }
    for (const p of PRIVACY_PATTERNS) {
      if (p.test(text.replace(/[\s-]/g, ''))) {
        await logAudit(OPENID, 'privacy_pattern', text)
        return { ok: false, code: 'RISK_PRIVACY', message: '疑似患者隐私信息（身份证/手机号），请脱敏后发布' }
      }
    }
    // 第二道：msgSecCheck（v2）
    try {
      await cloud.openapi.security.msgSecCheck({
        openid: OPENID,
        scene: 2,
        version: 2,
        content: text
      })
      return { ok: true }
    } catch (e) {
      if (e.errCode === 87014) {
        await logAudit(OPENID, 'msgSecCheck', text)
        return { ok: false, code: 'RISK_CONTENT', message: '内容含违规信息，请修改后重试' }
      }
      console.error('msgSecCheck error', e)
      return { ok: false, code: 'SEC_CHECK_FAIL', message: '系统繁忙，请稍后重试' }
    }
  }

  // 第三道：图片 imgSecCheck（fileID 逐张）
  async function secCheckImages(fileIDs) {
    if (!fileIDs || !fileIDs.length) return { ok: true }
    if (fileIDs.length > 3) return { ok: false, message: '图片最多 3 张' }
    for (const fileID of fileIDs) {
      try {
        const { fileList } = await cloud.getTempFileURL({ fileList: [fileID] })
        const url = fileList[0] && fileList[0].tempFileURL
        if (!url) return { ok: false, code: 'RISK_IMAGE', message: '图片读取失败，请重新上传' }
        const res = await cloud.downloadFile({ fileID })
        const check = await cloud.openapi.security.imgSecCheck({
          media: { contentType: 'image/png', value: res.fileContent }
        })
        if (check && check.errCode === 87014) {
          await logAudit(OPENID, 'imgSecCheck', fileID)
          return { ok: false, code: 'RISK_IMAGE', message: '图片含违规内容，请更换' }
        }
      } catch (e) {
        if (e.errCode === 87014) {
          await logAudit(OPENID, 'imgSecCheck', fileID)
          return { ok: false, code: 'RISK_IMAGE', message: '图片含违规内容，请更换' }
        }
        console.error('imgSecCheck error', e)
        return { ok: false, code: 'SEC_CHECK_FAIL', message: '图片检测繁忙，请稍后重试' }
      }
    }
    return { ok: true }
  }

  async function logAudit(openid, gate, snapshot) {
    await db.collection('audit_logs').add({
      data: {
        openid, gate,
        snapshot: String(snapshot).slice(0, 200),
        created_at: new Date()
      }
    }).catch(() => {})
  }

  function mask(s) { return s.length > 2 ? s.slice(0, 2) + '**' : '**' }

  // ════════ 发帖 ════════
  if (action === 'createPost') {
    const user = await getUser()
    if (!user) return { ok: false, code: 'NO_USER', message: '请先登录' }
    if (user.verify_status !== 'verified') {
      return { ok: false, code: 'NOT_VERIFIED', message: '完成医院认证后可发帖' }
    }

    const { topic, title, content, images, isAnonymous } = event
    if (!TOPICS.includes(topic)) return { ok: false, message: '请选择话题' }
    if (!title || !String(title).trim()) return { ok: false, message: '标题不能为空' }
    if (!content || !String(content).trim()) return { ok: false, message: '正文不能为空' }

    const textCheck = await secCheckText(`${title}\n${content}`)
    if (!textCheck.ok) return textCheck
    const imgCheck = await secCheckImages(images)
    if (!imgCheck.ok) {
      // 图片违规：清理已上传文件，不留垃圾
      if (images && images.length) {
        await cloud.deleteFile({ fileList: images }).catch(() => {})
      }
      return imgCheck
    }

    const now = new Date()
    const added = await db.collection('posts').add({
      data: {
        topic,
        title: String(title).trim().slice(0, 30),
        content: String(content).trim().slice(0, 1000),
        images: images || [],
        author_uid: user._id,                       // 服务端始终记真实 uid（追责）
        author_snapshot: {
          nickname: user.nickname || '医务工作者',
          hospitalName: user.hospitalName || '',
          role: user.role
        },
        is_anonymous: !!isAnonymous,                // D15：展示层匿名
        province: user.province || '',
        city: user.city || '',
        like_count: 0,
        comment_count: 0,
        status: 'active',
        created_at: now,
        updated_at: now
      }
    })
    return { ok: true, postId: added._id }
  }

  // ════════ 帖子列表（D13：话题/时间/省市筛选 + 分级可见性）════════
  if (action === 'listPosts') {
    const { topic, days, province, city, lastId } = event
    const where = { status: 'active' }
    if (topic && TOPICS.includes(topic)) where.topic = topic
    if (province) where.province = province
    if (city) where.city = city
    if (days && Number(days) > 0) {
      const since = new Date(Date.now() - Number(days) * 86400000)
      where.created_at = _.gte(since)
    }
    let query = db.collection('posts').where(where)
    if (lastId) {
      const last = await db.collection('posts').doc(lastId).get().catch(() => null)
      if (last && last.data) {
        // 简单分页：按 created_at 游标
        query = db.collection('posts').where(_.and([where, { created_at: _.lt(last.data.created_at) }]))
      }
    }
    const res = await query.orderBy('created_at', 'desc').limit(20).get()
    const user = await getUser()
    const uid = user ? user._id : null
    // 分级可见性：未认证（或游客）对病例讨论帖只显示标题，正文/图片/作者打码
    const verified = !!(user && user.verify_status === 'verified')
    // 批量查我的点赞
    let likedSet = new Set()
    if (uid && res.data.length) {
      const likes = await db.collection('post_likes').where({
        uid, post_id: _.in(res.data.map(p => p._id))
      }).get()
      likes.data.forEach(l => likedSet.add(l.post_id))
    }
    return {
      posts: res.data.map(p => {
        const gated = !verified && p.topic === 'case_discussion'
        return {
          _id: p._id,
          topic: p.topic,
          title: p.title,
          content: gated ? '' : (p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content),
          images: gated ? 0 : (p.images || []).length,
          gated,
          author: gated ? '认证后可见' : (p.is_anonymous ? '匿名用户' : (p.author_snapshot.nickname + (p.author_snapshot.hospitalName ? ' · ' + p.author_snapshot.hospitalName : ''))),
          isAnonymous: p.is_anonymous,
          likeCount: p.like_count,
          commentCount: p.comment_count,
          liked: likedSet.has(p._id),
          city: p.city,
          createdAgo: timeAgo(p.created_at)
        }
      })
    }
  }

  // ════════ 帖子详情（分级可见性）════════
  if (action === 'getPost') {
    const { postId } = event
    const p = await db.collection('posts').doc(postId).get().catch(() => null)
    if (!p || !p.data || p.data.status !== 'active') return { ok: false, message: '帖子不存在' }
    const post = p.data
    const user = await getUser()
    // 分级可见性：未认证访问病例讨论帖 → 只给标题与锁定标记
    const verified = !!(user && user.verify_status === 'verified')
    const gated = !verified && post.topic === 'case_discussion' && (!user || user._id !== post.author_uid)
    if (gated) {
      return {
        ok: true,
        gated: true,
        post: {
          _id: post._id,
          topic: post.topic,
          title: post.title,
          content: '',
          images: [],
          gated: true,
          author: '认证后可见',
          isMine: false,
          likeCount: post.like_count,
          commentCount: post.comment_count,
          liked: false,
          city: post.city,
          createdAgo: timeAgo(post.created_at)
        }
      }
    }
    let liked = false
    if (user) {
      const l = await db.collection('post_likes').where({ post_id: postId, uid: user._id }).count()
      liked = l.total > 0
    }
    return {
      ok: true,
      gated: false,
      post: {
        _id: post._id,
        topic: post.topic,
        title: post.title,
        content: post.content,
        images: post.images || [],
        author: post.is_anonymous ? '匿名用户' : (post.author_snapshot.nickname + (post.author_snapshot.hospitalName ? ' · ' + post.author_snapshot.hospitalName : '')),
        isAnonymous: post.is_anonymous,
        isMine: !!(user && user._id === post.author_uid),
        likeCount: post.like_count,
        commentCount: post.comment_count,
        liked,
        city: post.city,
        createdAgo: timeAgo(post.created_at)
      }
    }
  }

  // ════════ 评论/回复（D16 两级）════════
  if (action === 'comment') {
    const user = await getUser()
    if (!user) return { ok: false, code: 'NO_USER', message: '请先登录' }
    if (user.verify_status !== 'verified') {
      return { ok: false, code: 'NOT_VERIFIED', message: '完成医院认证后可评论' }
    }

    const { postId, parentId, replyToUid, replyToName, content, isAnonymous } = event
    const p = await db.collection('posts').doc(postId).get().catch(() => null)
    if (!p || !p.data || p.data.status !== 'active') return { ok: false, message: '帖子不存在' }
    if (parentId) {
      const parent = await db.collection('comments').doc(parentId).get().catch(() => null)
      if (!parent || !parent.data || parent.data.post_id !== postId) {
        return { ok: false, message: '被回复的评论不存在' }
      }
    }

    const textCheck = await secCheckText(content)
    if (!textCheck.ok) return textCheck

    const now = new Date()
    await db.collection('comments').add({
      data: {
        post_id: postId,
        parent_id: parentId || null,
        reply_to_uid: replyToUid || null,
        reply_to_name: replyToName || '',
        author_uid: user._id,
        author_snapshot: {
          nickname: user.nickname || '医务工作者',
          hospitalName: user.hospitalName || ''
        },
        is_anonymous: !!isAnonymous,
        content: String(content).trim().slice(0, 300),
        status: 'active',
        created_at: now
      }
    })
    await db.collection('posts').doc(postId).update({
      data: { comment_count: _.inc(1), updated_at: now }
    })
    return { ok: true }
  }

  // ════════ 评论列表（一级 + 二级挂载）════════
  if (action === 'listComments') {
    const { postId } = event
    const res = await db.collection('comments')
      .where({ post_id: postId, status: 'active' })
      .orderBy('created_at', 'asc')
      .limit(100)
      .get()
    const user = await getUser()
    const uid = user ? user._id : null
    const tops = [], children = {}
    res.data.forEach(c => {
      const item = {
        _id: c._id,
        parentId: c.parent_id,
        replyToName: c.reply_to_name,
        author: c.is_anonymous ? '匿名用户' : (c.author_snapshot.nickname + (c.author_snapshot.hospitalName ? ' · ' + c.author_snapshot.hospitalName : '')),
        isMine: !!(uid && uid === c.author_uid),
        content: c.content,
        createdAgo: timeAgo(c.created_at)
      }
      if (c.parent_id) {
        (children[c.parent_id] = children[c.parent_id] || []).push(item)
      } else {
        tops.push(item)
      }
    })
    tops.forEach(t => { t.replies = children[t._id] || [] })
    return { comments: tops }
  }

  // ════════ 点赞/取消（唯一索引防重）════════
  if (action === 'toggleLike') {
    const user = await getUser()
    if (!user) return { ok: false, code: 'NO_USER', message: '请先登录' }
    const { postId } = event
    const existed = await db.collection('post_likes').where({ post_id: postId, uid: user._id }).get()
    const now = new Date()
    if (existed.data.length) {
      await db.collection('post_likes').doc(existed.data[0]._id).remove()
      await db.collection('posts').doc(postId).update({
        data: { like_count: _.inc(-1), updated_at: now }
      })
      return { ok: true, liked: false }
    }
    await db.collection('post_likes').add({ data: { post_id: postId, uid: user._id, created_at: now } })
    await db.collection('posts').doc(postId).update({
      data: { like_count: _.inc(1), updated_at: now }
    })
    return { ok: true, liked: true }
  }

  // ════════ 删除（仅作者，逻辑删除，D15/D16）════════
  if (action === 'deletePost') {
    const user = await getUser()
    if (!user) return { ok: false, message: '请先登录' }
    const { postId } = event
    const p = await db.collection('posts').doc(postId).get().catch(() => null)
    if (!p || !p.data) return { ok: false, message: '帖子不存在' }
    if (p.data.author_uid !== user._id) return { ok: false, code: 'FORBIDDEN', message: '只能删除自己的帖子' }
    await db.collection('posts').doc(postId).update({
      data: { status: 'deleted', deleted_at: new Date() }
    })
    return { ok: true }
  }

  if (action === 'deleteComment') {
    const user = await getUser()
    if (!user) return { ok: false, message: '请先登录' }
    const { commentId } = event
    const c = await db.collection('comments').doc(commentId).get().catch(() => null)
    if (!c || !c.data) return { ok: false, message: '评论不存在' }
    if (c.data.author_uid !== user._id) return { ok: false, code: 'FORBIDDEN', message: '只能删除自己的评论' }
    const now = new Date()
    await db.collection('comments').doc(commentId).update({
      data: { status: 'deleted', deleted_at: now }
    })
    await db.collection('posts').doc(c.data.post_id).update({
      data: { comment_count: _.inc(-1), updated_at: now }
    })
    return { ok: true }
  }

  return { ok: false, message: '未知 action' }
}

function timeAgo(d) {
  if (!d) return ''
  const diff = Date.now() - new Date(d).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const day = Math.floor(h / 24)
  if (day < 30) return `${day}天前`
  return `${Math.floor(day / 30)}个月前`
}
