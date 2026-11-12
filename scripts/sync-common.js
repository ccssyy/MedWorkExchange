// 将 cloudfunctions/common/ 同步到消费它的云函数目录（部署相关云函数前运行）
// 用法：node scripts/sync-common.js
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'cloudfunctions')
const targetFns = ['dealing', 'posts', 'application', 'review', 'report', 'message']

for (const fn of targetFns) {
  if (!fs.existsSync(path.join(root, fn))) {
    console.error(`目标函数目录不存在: ${fn}`)
    process.exitCode = 1
    continue
  }
  fs.copyFileSync(path.join(root, 'common', 'content-security.js'), path.join(root, fn, 'content-security.js'))
  console.log('synced ->', fn)
}
