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

- main @ ae7a103（M1 骨架 = v0.1.0）
- develop @ ae7a103
- feature/m2-matching-flow（进行中）：申请/确认状态机、超时任务、搜索筛选
