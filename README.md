# MedWorkExchange

医学生院内信息撮合小程序 —— 换班调班 · 病例指导 · 简历指导

信息汇总、分发与联络平台。实际服务（值班、指导）在线下完成，酬金由双方线下点对点结清，**平台不碰资金**。验证期仅做信息撮合，不做交易与资金托管。

## 文档

- [产品与架构设计文档](./docs/architecture-and-product-design.md) —— 设计基线，开发依据
- [前期调研与决策记录](./docs/compliance-and-product-scope.md) —— 合规边界与选型调研

## 技术栈

- 前端：原生微信小程序（WXML / WXSS / JS）
- 后端：微信云开发 CloudBase（云函数 / 云数据库 / 云存储）
- 隔离：医院=数据租户，服务端强制隔离 + 数据库安全规则兜底

## 当前状态

M1 工程骨架已就绪。Pilot 范围：长春 3 家吉大医院（吉大一院 / 吉大二院 / 中日联谊医院）小范围验收。

## 工程结构

```
├── project.config.json        # IDE 配置（appid / 云函数根目录）
├── miniprogram/               # 小程序端
│   ├── app.js                 # 云开发 init（环境 ID 待填）
│   ├── app.json               # tabBar 四页：首页/发布/消息/我的
│   ├── pages/
│   │   ├── index/             # 本院列表 + 类目筛选 + 医院切换（透明浏览）
│   │   ├── publish/           # 双模式发布（需求单 / 挂牌服务）
│   │   ├── messages/          # 会话列表（M3 实现私信收发）
│   │   └── profile/           # 用户档案 + 认证入口 + 免责声明
│   └── assets/                # tabBar 占位图标
├── cloudfunctions/            # 云函数
│   ├── login/                 # openid 建档 + 用户档案
│   ├── hospital/              # 省市医院级联查询
│   ├── dealing/               # 撮合单创建/列表（hospital_id 服务端注入，越权拒绝）
│   └── message/               # 会话列表（M3 扩展收发）
├── scripts/
│   └── init-db.js             # 数据库初始化（8 集合 + 3 家吉大预置）
└── docs/                      # 设计文档
```

## 本地开发步骤

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（Stable）；
2. 导入项目：选择本仓库根目录，AppID 已配置（wx31604a391caca372）；
3. 开通云开发：工具栏「云开发」→ 创建环境 → **把环境 ID 填入 `miniprogram/app.js` 的 `cloudEnv`**；
4. 初始化数据库：云开发控制台执行 `scripts/init-db.js`，并按注释补 3 个复合索引；
5. 部署云函数：右键 `cloudfunctions/` 下各目录 →「上传并部署：云端安装依赖」；
6. 编译预览。

## 里程碑

- [x] M1 骨架：工程 + 登录建档 + 医院数据 + 撮合单发布/列表（含隔离）
- [ ] M2 撮合主链路：申请/确认状态机、超时任务、搜索筛选
- [ ] M3 联络与闭环：私信收发、订阅消息、履约确认、互评、信用分
- [ ] M4 收尾提审：举报仲裁、内容安全全量、隐私协议、提审
