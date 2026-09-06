# Daedalus CRM

给 1–20 人的教培 / 升学咨询团队用的客户管理系统：线索、学员、跟进、商机、推荐归属，
外加五个**只起草、不落库**的 AI 功能。自己部署，数据放在自己手里，一份 SQLite 文件就是全部。

不是教培也能用：客户叫什么、字段叫什么、状态显示成什么，都在设置页里改，不用碰代码。

![数据首页](docs/shots/02-dashboard.png)

## 一分钟跑起来

有 Docker 就行：

```bash
docker run -d --name crm -p 3000:3000 -v crm-data:/data --restart unless-stopped ghcr.io/becky824/daedalus-crm
docker logs crm | grep 初始密码
```

打开 http://localhost:3000，用户名 `admin`，密码就是日志里那个。登录后到「设置管理 → 修改密码」改掉。

没有任何东西要配：会话密钥自动生成并保存在数据卷里，数据库自动建表，升级时迁移自动跑。
想用 compose、加 HTTPS、备份恢复、升级回滚，看 [docs/部署.md](docs/部署.md)——也都是一两条命令。

## 配 AI

管理员登录 → **设置管理 → AI 接入**，填三项：接口地址、API Key、模型名，点「测试连接」，再保存。
任何 OpenAI 兼容接口都行：

| | 接口地址 | 模型名示例 |
|---|---|---|
| DeepSeek 官方 | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 本地 Ollama | `http://host.docker.internal:11434/v1` | `qwen2.5`（Key 随便填） |
| 各类中转站 | 它给你的地址 | 它支持的模型名 |

不配就没有 AI 入口，其余功能照常。Key 加密存库，界面只回显尾 4 位；同一页能看到本月各功能用了多少次。

## 不是教培？改术语

**设置管理 → 业务配置**：一段业务简介（进所有 AI 提示词）、客户叫什么（学员 / 客户 / 会员）、
三个档案字段名（院校 / 年级 / 专业 → 公司 / 类型 / 行业）、三组下拉选项、状态显示名。全站同步，数据库不动。

## 有什么

| 学员列表 | 学员详情 |
|---|---|
| ![](docs/shots/04-customers.png) | ![](docs/shots/05-customer-detail.png) |

**线索 → 学员 → 跟进 → 商机 → 签约**这条主链，加上小团队真正会踩的坑：

- **推荐归属**：推荐人、渠道归属（推荐链往上第二代）、渠道负责人三者独立记录，录入时固化
- **并发保护**：两人同时改一条学员，不同字段自动合并，同一字段才拦
- **操作留痕**：所有人可见可改全部数据，每次写操作记日志，只增不删
- **查重**：手机号失焦即预警并说清撞的是谁；同一天同金额的签约要二次确认
- CSV 导出、登录限流、XSS 按字面显示

**五个 AI 功能**，AI 只起草，人核对后走原有保存流程：

| 功能 | 在哪 | 做什么 |
|---|---|---|
| 跟进速记 | 新建跟进弹窗 | 口述或粘贴微信聊天记录，AI 预填类型、要点、下次计划、待办 |
| 临战简报 | 学员详情 | 联系前一键生成：故事线、卡在哪、建议谈什么、风险 |
| 问数据 | 数据复盘 | 自然语言问业务数字。AI 只翻译成受限查询规格，不写 SQL |
| 盯盘提醒 | 数据首页 | 被遗忘的学员 / 停滞的商机 / 逾期的计划，检测是纯规则，AI 只写话术 |
| 转介绍雷达 | 渠道管理 | 谁在帮你带人、下一个该请谁开口，排序是纯规则，AI 只写邀请 |

## 本地开发

```bash
npm install && npm run setup && npm run dev
```

http://localhost:3000，`admin` / `crm@2026`（开发库的三个演示账号：`admin`、`zhangsan` 张三、`lisi` 李四）。
测试、纪律、提交流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

Next.js 16 · Ant Design 6 · ECharts · Prisma + SQLite。Vitest 234 条 + Playwright 58 条，CI 上全跑。

## 其他

[docs/部署.md](docs/部署.md) · [SECURITY.md](SECURITY.md) · [ROADMAP.md](ROADMAP.md) · 许可证 AGPL-3.0：自托管随便用、随便改；改了并对外提供服务，要公开改动。
