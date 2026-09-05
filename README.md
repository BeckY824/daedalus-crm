# CRM 客户管理系统

客户全周期管理 —— 线索、客户、联系人、跟进、商机的一体化管理，界面按设计稿实现。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16（App Router，React Server Components + Server Actions） |
| UI | Ant Design 6 + 自定义主题（品牌蓝 `#1668dc`） |
| 图表 | ECharts 6（按需引入） |
| 数据库 | SQLite + Prisma ORM |
| 鉴权 | JWT（jose）存 httpOnly Cookie + bcrypt 密码哈希 |

## 快速开始

```bash
npm install
npm run setup   # 生成 Prisma Client + 建表 + 灌入演示数据
npm run dev
```

打开 http://localhost:3000

### 账号（初始密码均为 `crm@2026`）

**登录用「用户名」，不是邮箱。**

| 用户名 | 系统内姓名 | 角色 |
|---|---|---|
| `admin` | 管理员 | 系统管理员（可增删成员、看操作日志） |
| `zhangsan` | 张三 | 销售 |
| `lisi` | 李四 | 销售 |

各自登录后请到「设置管理 → 修改密码」改掉初始密码（至少 8 位）。

账号名单维护在 [`prisma/seed.ts`](prisma/seed.ts) 的 `USERS`。
改完在已有库上重跑 `node seed.js` 即可同步姓名与角色（不会动密码）。

## 已实现的功能

**数据首页** — 线索总数、活跃客户、本月新增商机、预测销售额四张指标卡；近 7/30/90 天客户趋势折线图；销售团队业绩排行；商机管道漏斗；近期跟进任务。预测销售额按 `Σ(商机金额 × 成交概率)` 计算。

**线索管理** — 线索录入、状态流转、一键转客户（自动建客户 + 联系人并回写关联）。

**学员管理** — 多维筛选（年级 / 跟进状态 / 决策状态 / 销售负责人 / 渠道负责人 / 关键词）、分页、批量分配负责人、批量改状态、批量删除、CSV 导出（带 BOM、按 RFC 4180 转义、挡公式注入）。

**推荐归属** — 三个角色互相独立：推荐人（谁介绍来的，逐级如实记录）、渠道归属（推荐链往上第二代，不足两代取链条顶端）、渠道负责人（顶端渠道所属员工，整条链继承）。归属在录入时固化，改上游不会追溯性地改动已有学员的业绩。

**并发保护** — 两人同时编辑同一条学员时，改不同字段自动合并，改同一字段才拦下并说明撞了哪几项；两人同时转化同一条线索只会建出一条学员；删除被他人当作推荐人的学员会被拒绝。

**操作留痕** — 所有人可见可改全部数据，但每次写操作都记录在「设置管理 → 操作日志」，只增不改不删。

**客户详情** — 这是"跟踪客户"的核心页：
- 跟进动态时间线，8 种跟进类型（电话/会议/拜访/邮件/短信/任务/提醒/其他），支持按类型过滤
- 待办任务勾选完成
- 下次跟进计划（主题 / 时间 / 方式）
- 沟通统计（跟进次数、累计通话时长、会议数、邮件数）
- 关键联系人、关联商机、客户资料

**商机管理** — 列表视图（阶段行内切换、赢单/丢单）+ 管道看板（拖拽卡片推进阶段）。阶段变更自动同步成交概率。

**跟进管理** — 全局跟进记录检索；跟进计划页按「我的 / 全部成员」和「逾期 / 今天 / 本周」筛选。

**设置管理** — 团队成员增删改、角色权限、停用成员时强制转交名下客户与商机、修改密码。

## 数据模型

```
User ──┬─< Customer ──┬─< Contact
       │              ├─< FollowUp ──> Contact / Opportunity
       │              ├─< Task
       │              ├─< FollowPlan
       │              └─< Opportunity
       └─< Lead ──(转化)──> Customer
```

枚举值统一维护在 [`src/lib/constants.ts`](src/lib/constants.ts)（SQLite 不支持原生 enum，故以 String 存储）。

## 换成 PostgreSQL

改 `prisma/schema.prisma` 的 datasource，再改 `.env`：

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/crm"
```

然后 `npm run setup` 重新建表灌数据。业务代码无需改动。

## 常用命令

```bash
npm run dev        # 开发服务器
npm run build      # 生产构建
npm test           # 单元 + Server Action（约 2 秒）
npm run test:coverage  # 归属算法的覆盖率（门禁要求满覆盖）
npm run test:e2e   # E2E（Playwright，约 3 分钟）
npm run test:ai    # AI 功能验收（真的调 AI，慢且花钱；需先 npm run dev -- --port 3100）
npm run db:studio  # Prisma Studio 可视化查看数据
npm run db:reset   # 清库重建 + 重新灌演示数据
```

## 提交前的自动关卡

这个仓库没有远端，用不上 GitHub Actions 之类，所以**唯一的自动关卡是本地 git 钩子**。
每台机器克隆后启用一次：

```bash
git config core.hooksPath hooks
```

之后每次 `git push` 会自动跑 `tsc --noEmit`、`eslint`、`vitest run`，约 8 秒，任一失败即中断推送。
E2E 要起 dev server、跑三分钟，不进钩子——维持「合并后手跑 + 部署后线上复验」。

没启用这一条的后果是有先例的：项目曾有三个类型错误在代码里躺了很久，
因为当时没有任何自动关卡，全靠人记得手跑。

## 相关文档

| 文档 | 内容 |
|---|---|
| [DEPLOY.md](DEPLOY.md) | 线上环境、发布、备份与恢复、常用运维命令 |
| [TESTING.md](TESTING.md) | 测试执行结果、发现并修复的问题、已知行为 |
| [docs/使用须知.md](docs/使用须知.md) | **给销售看的一页说明**，UAT 前需要发给全部使用者 |
| [docs/手工测试清单.md](docs/手工测试清单.md) | 机器判定不了、需要人来走的部分 |
| [migrations/README.md](migrations/README.md) | 存量库怎么加表 |

## 尚未实现

合同管理、产品管理、目标管理。入口未放进侧边栏，见路线图。

## AI 功能

跟进速记（新建跟进弹窗里把口头转述**或直接粘贴的微信聊天记录**丢给 AI 预填表单）、临战简报（客户详情页一键生成沟通简报）、
转介绍雷达（渠道管理页：谁在帮我们带人 + 下一个该请谁开口，纯规则见 `src/lib/referral.ts`，AI 按需起草邀请话术）、
问数据（数据复盘页用自然语言查业务数字——AI 只把问题翻译成受限的查询规格，不写 SQL，见 `src/lib/report-query.ts`）、
盯盘提醒（数据首页列出被遗忘的学员/商机/逾期计划——检测是纯规则实时计算，见 `src/lib/sentinel.ts`，
不依赖定时任务；AI 只在点「起草跟进」时生成唤醒话术，由销售自己复制到微信发出）。
任何 OpenAI 兼容接口都能接（DeepSeek 官方、OpenAI、中转站、本地 Ollama），`.env` 配置：

```
LLM_API_KEY=你的密钥            # 不配置则 AI 入口整体不渲染，其余功能不受影响
LLM_BASE_URL="https://api.deepseek.com/v1"
LLM_MODEL="deepseek-chat"
```

原则：AI 只起草、不落库，人核对后走原有 Server Action 保存；调用细节见 [`src/lib/llm.ts`](src/lib/llm.ts)。

## 生产部署前必做

- `.env` 里的 `AUTH_SECRET` 换成随机长字符串（**生产环境缺失或不足 32 位会直接拒绝启动**，这是有意的）
- 三个账号各自登录后改掉初始密码
- 数据量起来后再考虑换 PostgreSQL；当前 SQLite 跑在 WAL 模式下，几人并发够用
