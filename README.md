# Daedalus CRM

**下一代 CRM，跑在你自己的机器上。AI 起草，你来拍板。**

给小团队用的客户管理系统：线索、客户、跟进、商机、推荐归属，外加六个只起草不落库的 AI 功能。
自己部署，数据在自己手里。默认按教培场景措辞，改个设置就能用于任何销售团队。

![数据首页](docs/shots/02-dashboard.png)

## 上手

**用 Docker**

```bash
git clone https://github.com/BeckY824/daedalus-crm.git && cd daedalus-crm
docker compose up -d
```

**或者本地跑**（Node 22+）

```bash
git clone https://github.com/BeckY824/daedalus-crm.git && cd daedalus-crm
npm install && npm run setup && npm run dev
```

然后打开 **http://localhost:3000**

| 用户名 | 密码 | 身份 |
|---|---|---|
| `admin` | `admin123` | 管理员 |
| `zhangsan` | `admin123` | 销售「张三」（演示） |
| `lisi` | `admin123` | 销售「李四」（演示） |

登录后到「设置管理 → 修改密码」把密码改掉。就这些。

**想用 AI**：管理员进「设置管理 → AI 接入」，填接口地址、API Key、模型名，点「测试连接」，保存。
DeepSeek、OpenAI、本地 Ollama、各种中转站都行。不填就没有 AI 入口，其余功能照常。

**不是教培**：「设置管理 → 业务配置」里把「学员」改成「客户」、「院校 / 年级 / 专业」改成你的字段名，全站同步。

## 有什么

| 客户列表 | 客户详情 |
|---|---|
| ![](docs/shots/04-customers.png) | ![](docs/shots/05-customer-detail.png) |

- **主链**：线索 → 客户 → 跟进 → 商机 → 签约，管道看板拖拽推进
- **推荐归属**：谁介绍的、业绩算谁的，录入时固化，改上游不追溯
- **不出错**：手机号查重、同金额签约二次确认、两人同时编辑按字段合并、全部写操作留痕
- **首页是一个对话面**：问一位客户出简报，问一个数出图表，建议 chip 按你今天的处境生成；指标与图表在「数据看板」
- **记录页**：左边档案点一下就能改，中间一条时间线，顶部随手记一笔或粘一段聊天记录；右边 AI 面板常驻——打开谁，它已经读完了谁
- **AI 六件事**：首页提问（问一位客户出简报，问一个数出数据）、跟进速记（粘微信聊天记录直接预填表单，原文留存）、临战简报、问数据、盯盘提醒与解读、转介绍雷达。AI 只起草，人核对后才保存
- **原文留存**：速记粘进来的聊天记录不丢，简报和话术引用客户原话，而不是只看整理后的要点

## 更多

- [docs/部署.md](docs/部署.md) — HTTPS、升级、备份恢复、所有环境变量
- [docs/配置.md](docs/配置.md) — AI 接入细节、术语与状态显示名
- [CONTRIBUTING.md](CONTRIBUTING.md) — 开发、测试、提交
- [SECURITY.md](SECURITY.md) · [ROADMAP.md](ROADMAP.md)
- 许可证 AGPL-3.0：自托管随便用、随便改；改了并对外提供服务，要公开改动
