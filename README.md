# MedWorkExchange

医学生院内信息撮合小程序 —— 换班调班 · 病例指导 · 简历指导

信息汇总、分发与联络平台。实际服务（值班、指导）在线下完成，酬金由双方线下点对点结清，**平台不碰资金**。验证期仅做信息撮合，不做交易与资金托管。

## 文档

- [产品与架构设计文档](./docs/architecture-and-product-design.md) —— 设计基线，开发依据
- [前期调研与决策记录](./docs/compliance-and-product-scope.md) —— 合规边界与选型调研

## 技术栈

- 前端：原生微信小程序（WXML / WXSS / JS），5-tab（需求/留言板/发布/消息/我的）
- 后端：微信云开发 CloudBase（云函数 / 云数据库 / 云存储），无自建服务器
- 信息域：默认本院，支持搜索切换浏览他院，**跨院申请放开**（设计决策 D8；规培生跨院帮忙是核心场景）

## 当前状态

M1–M5 主链路已落地并合入 `develop`：双模式撮合状态机、站内私信、履约双向确认、互评信用分、举报仲裁、医务认证（OCR 自动预审 + 人工审核）、患者陪诊端、留言板。
发布基线：`main @ v0.2.0`；`develop` 为集成主线。Pilot 范围：长春 3 家吉大医院（吉大一院 / 吉大二院 / 中日联谊医院）小范围验收。

待补（提审前必须）：订阅消息通知、超时 timer 云函数、隐私保护指引后台配置、类目资质、微信认证。接手与排期详见 [交接计划](./docs/handover-plan.md)。

## 工程结构

```
├── project.config.json        # IDE 配置（appid / 云函数根目录）
├── miniprogram/               # 小程序端（13 页）
│   ├── app.js                 # 云开发 init（环境 ID 硬编码于此）
│   ├── app.json               # tabBar 五页：需求/留言板/发布/消息/我的
│   ├── pages/                 # index/board/publish/messages/profile (tab)
│   │                          # + detail/my-list/chat/post-publish/post-detail
│   │                          # + verify-submit/admin-verify/patient-activate
│   └── assets/                # tabBar 图标
├── cloudfunctions/            # 10 个云函数
│   ├── login / hospital       # 建档认证档案 / 医院级联查询
│   ├── dealing / application  # 撮合单状态机 / 申请-确认
│   ├── message / review       # 站内私信 / 互评信用分
│   ├── report / posts         # 举报仲裁 / 留言板
│   ├── verify / initdb        # 医务认证(OCR) / 运维初始化+测试辅助（TEST_KEY 保护）
├── scripts/
│   └── init-db.js             # 数据库初始化（14 集合 + 3 家吉大预置 + 索引清单注释）
├── test/automator/            # miniprogram-automator 验收脚本（19 个）+ 踩坑 README
└── docs/                      # 设计基线 / 合规边界 / 验收清单 / 管理手册 / 交接计划
```

## 本地开发步骤

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（Stable）；
2. 导入项目：选择本仓库根目录，AppID 已配置（wx31604a391caca372）；
3. 开通云开发：工具栏「云开发」→ 创建环境 → **把环境 ID 填入 `miniprogram/app.js` 的 `cloudEnv`**；
4. 初始化数据库：新版控制台无脚本入口，直接部署并调用 `initdb` 云函数（需先在其环境变量配置 `TEST_KEY`）；老环境可执行 `scripts/init-db.js`，并按注释补 4 个复合索引；
5. 部署云函数：右键 `cloudfunctions/` 下各目录 →「上传并部署：云端安装依赖」（或 `cli cloud functions deploy`，多函数需逐个部署）；
6. 编译预览。

## 里程碑

- [x] M1 骨架：工程 + 登录建档 + 医院数据 + 撮合单发布/列表
- [x] M2 撮合主链路：申请/确认状态机、详情页、搜索筛选（tag v0.2.0）
- [x] M3 联络与闭环：私信收发、履约确认、互评、信用分（订阅消息未做，见 TODO(M3) 预埋）
- [x] M4+ 收尾：举报仲裁、内容安全全量、v1.1 需求变更（5-tab/留言板/极简发布/陪诊类目）
- [x] M5 医务认证：OCR 自动预审 + 人工后台审核（学信网接口预留）；患者陪诊端
- [ ] 提审准备：订阅消息、timer 超时任务、隐私保护指引配置、类目资质、微信认证
