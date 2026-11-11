# 分支与版本管理规范

## 分支模型

```
main      稳定基线：每个里程碑验收通过后合入，始终可部署
develop   日常集成：功能分支的合流处，保持最新开发态
feature/* 里程碑/功能开发分支：从 develop 切出，完成后合回 develop
```

- 命名：`feature/m{里程碑}-{主题}`，如 `feature/m2-matching-flow`；修复用 `fix/{主题}`
- feature 分支按节奏推送远程（备份 + 可审查），合入 develop 用 **merge --no-ff**（保留里程碑边界）

## 合并时点

| 时点 | 动作 |
|---|---|
| 里程碑开发完成 | feature → develop（merge --no-ff，PR 可选） |
| 里程碑验收通过（跑通验收用例） | develop → main，打 tag `v0.{里程碑}.{序号}`（如 v0.2.0 = M2） |
| main 上发现缺陷 | 从 main 切 `fix/*`，修复合回 develop 与 main |

## 提交规范

格式：`类型(范围): 摘要`（中文摘要，一行 ≤50 字）

| 类型 | 用途 |
|---|---|
| feat | 新功能 |
| fix | 缺陷修复 |
| docs | 文档 |
| refactor | 重构（不改行为） |
| chore | 构建/脚本/配置 |

示例：`feat(dealing): 申请与确认状态机`、`fix(index): 医院切换后列表未刷新`、`docs(readme): 补充云开发步骤`

## 当前状态

- main @ 261f5da（tag v0.2.0 = M2 + v1.1 验收通过，2026-08-27）
- develop 为集成主线：已合入 M3 联络闭环（f2498ae…3d4c9e0）、患者陪诊端（26ed56c）、M4 举报仲裁（6783262）、M5 医务认证（97b95c8）
- 已合并分支已于 2026-11-11 清理（本地+远端同删）：feature/m2-matching-flow、feature/v1.1-requirement-changes、feature/m3-messaging、feature/m4-report、feature/patient-escort（全部提交均在 develop 历史中，无丢失）
- 长期分支模型：`main` 发布基线 / `develop` 集成主线 / `wip/*` 未完成工作占位——现存 `wip/s4-notify-timer`（fcb6ff1，前任遗留的订阅消息 notify + 超时 timer 半成品，24 文件 2156 行，含设计文档与单测基建；基于 8d7a587 旧基线，与 S2 安全止血改造有冲突，S4 启动时选择性合并）
- 2026-11-11 S2 安全止血：initdb 测试后门收口（TEST_KEY 只从环境变量读取）、4 函数 OPENID_OF 全局清除、markRead 成员校验（ee33af5）
- 下一步：S3 缺陷修复与 v0.3.0 发布，排期见 `docs/handover-plan.md` §8
- 注意：initdb 全部 action 需 `TEST_KEY` 环境变量匹配调用方 `testKey`，未配置的环境一律 FORBIDDEN（生产环境无需配置即关闭）
