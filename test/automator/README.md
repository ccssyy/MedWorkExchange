# miniprogram-automator 自动化验收脚本

用微信开发者工具自动化端口驱动模拟器，跑 v1.1 验收清单中的单账号用例。

## 前置条件（一次性）

1. IDE 命令行服务端口已开（配置 `security.enableServicePort=true`，已改好）
2. IDE 已启动且已登录：
   ```bash
   env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/open -a wechatwebdevtools
   ```
3. 开启自动化端口（关键：不要用 `cli auto`，它走窗口重开流程会丢 automator 服务）：
   ```bash
   # 读当前 CLI 端口
   cat ~/Library/Application\ Support/微信开发者工具/d1e8765721a6c23d43b14c95b1843e6b/Default/.cli
   # 用 HTTP API 开 automator 服务（返回 {"winId":"s0","autoPort":9420} 即成功）
   curl "http://127.0.0.1:<cli端口>/v2/auto?project=/Users/samchen/Work/git/MedWorkExchange&autoPort=9420"
   ```

## 运行

```bash
cd /Users/samchen/.workbuddy/binaries/node/workspace   # miniprogram-automator 安装处
NODE_PATH=$PWD/node_modules node /Users/samchen/Work/git/MedWorkExchange/test/automator/verify_a1a2a4.js
```

## 脚本清单与覆盖用例

| 脚本 | 覆盖 |
|---|---|
| verify_a1a2a4.js | A1 别名搜索 / A2 发布默认值 / A4 时间校验 |
| verify_a6a7a8.js | 发布两条价差单 → A6 筛选联动 / A7 关键词搜索(含负向) / A8 排序双向，结束自动下架清理 |
| verify_board.js | B1 匿名发帖 / B3 黑名单拦截 / B8 话题筛选 / B5 两级评论@ / B6 点赞 / B7 删评论，结束删帖清理 |
| verify_b4b6.js | B4 病例话题红条 / B6 点赞轮询复测版 |
| verify_a10.js | A9-A12 降级验证：`initdb.seedApplication` 构造账号B申请 → A10 确认撮合全链 / A12-A 我的发布，结束自动清理 |
| verify_v2.js | 需求单发布→编辑→下架→隐私拦截 全链 |
| verify_m3_chat.js | M3 模块1：发布→seed→确认→会话列表→聊天页收发→导流拦截→markRead |
| verify_m3_flow.js | M3 模块2：确认→开始履约→确认完成（含 completed 态重复完成被拒） |
| verify_m3_review.js | M3 模块3+4：互评卡渲染/提交/防重 + status 回读（黑名单/隐私拦截单独补测） |
| verify_escort_gate.js | 陪诊类目 + 病例讨论分级可见性 gate |
| verify_patient.js | 患者端：患者角色发布 escort 单/禁止接单/激活页渲染 |
| verify_m4_report.js | M4 举报仲裁：seed B 接单→举报→防重/self 拦截→is_admin 仲裁成立→下架+落库→已办结再仲裁被拒（驳回/真机对端挪双账号补测） |

## 关键经验（踩坑记录）

- **post-publish 页 TOPICS 无「全部」**：index0=规培心得、index1=病例讨论；board 页 index0=全部。两页索引不同。
- 表单填写优先 `page.setData({title, fee})` 后点 `.submit-btn`，比逐个 input.input() 稳。
- 列表筛选切换用 `page.setData({sortIndex,feeIndex,topicIndex}) + page.callMethod('loadDealings'/'loadPosts')`，无需模拟 picker 手势。
- 云函数往返要**轮询**（500ms×16 次）等数据变化，固定 sleep 1.5s 会误判失败（B6 教训）。
- 发帖成功后是 `navigateBack()` 回留言板，不跳详情页。
- tabbar 页必须 `mp.switchTab()`；确认弹窗提前 `mp.mockWxMethod('showModal',{confirm:true})`。
- 双账号用例（A9-A12 部分环节、B5 的对端视角）需真机第二微信，automator 只能控制当前登录账号。
  - 单账号替代方案：`initdb` 云函数已加 `seedApplication` / `cleanTestApplication` action，可构造 `applicant_uid='TEST_USER_B'` 的申请记录驱动 A 端流程；A 端真实、B 端操作过程 N/A。
  - `initdb.setTestUser`（testKey 保护）可给当前登录用户临时设 `is_admin` / `credit_score`，用于仲裁流、信用分门槛等权限类用例；**用例开头先强制重置**再断言，防止上一轮 FATAL 未清理的脏状态（M4 首跑教训：遗留 is_admin=true 导致"非 admin 被拒"用例 FAIL）。
- my-list 页数据字段是 `list`（不是 items）；automator `mp.evaluate(fn, ...args)` 支持向 appService 传参执行 Promise。
- **mock showModal 必须在连接后立刻设置**——onAccept 等处理器里 await showModal，漏 mock 会永久挂起（M3 chat 首跑教训）。
- 全局配置改动（app.json 注册新页面/tabBar）热重载不可靠，需 `cli close` + `/v2/auto` 重开触发全量编译（tabBar 显示 M1 旧配置即此因）。
- `cli cloud functions deploy --names` 逗号分隔多函数在该 IDE 版本不生效，逐个部署。

## 环境常量

- cloudEnv: `cloud1-d9gwlepe0f2e51cb8`
- AppID: `wx31604a391caca372`
- automator ws: `ws://127.0.0.1:9420`
