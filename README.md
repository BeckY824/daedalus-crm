<div align="center">

<img src="docs/logo.svg" width="72" alt="Daedalus CRM" />

# Daedalus CRM

**下一代 CRM，跑在你自己的机器上。AI 起草，你来拍板。**

给 1–20 人小团队的客户管理系统：线索 → 客户 → 跟进 → 商机 → 签约，推荐归属自动算。<br/>
首页是一个 agent 对话面，问一句它自己决定查什么；想改数据它只给建议卡，你点确认才写入。

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/BeckY824/daedalus-crm/actions/workflows/ci.yml/badge.svg)](https://github.com/BeckY824/daedalus-crm/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/tag/BeckY824/daedalus-crm?label=release&sort=semver)](https://github.com/BeckY824/daedalus-crm/tags)
[![Docker](https://img.shields.io/badge/ghcr.io-daedalus--crm-2496ED?logo=docker&logoColor=white)](https://github.com/BeckY824/daedalus-crm/pkgs/container/daedalus-crm)
[![Stars](https://img.shields.io/github/stars/BeckY824/daedalus-crm?style=social)](https://github.com/BeckY824/daedalus-crm/stargazers)

**简体中文** · [English](README_EN.md)

[官网](https://ai-daedalus.com) · [免费试用](https://app.ai-daedalus.com/signup) · [部署文档](docs/部署.md) · [路线图](ROADMAP.md) · [反馈](https://github.com/BeckY824/daedalus-crm/issues)

</div>

<br/>

<div align="center">

**100% 开源 &nbsp;·&nbsp; 自托管，数据不出内网 &nbsp;·&nbsp; AI 只起草，写入永远由人点**

</div>

- ✅ 一条命令起来：`docker compose up -d`，零配置，不用信用卡
- ✅ 首页是一个 agent：问一位客户、问一个数，它自己决定搜谁、读谁、查什么，每一步看得见
- ✅ 让它「记一笔」「改成已签约」「约下周三」「新建商机」——出一张可编辑的建议卡，确认才落库
- ✅ 记录页粘一段微信聊天，AI 整理成跟进记录 / 待办 / 下次计划，原文留存
- ✅ 推荐归属：谁介绍的、业绩算谁的，录入时固化，改上游不追溯改写下游
- ✅ 手机号查重、同金额签约二次确认、两人同时编辑按字段合并、所有写操作留痕
- ✅ 模型无关：DeepSeek / OpenAI / 本地 Ollama / 任意中转站，设置页填一下就行
- ✅ 默认按教培场景措辞，改个设置就能用于任何销售团队

<br/>

![首页：agent 对话面](docs/shots/02-dashboard.png)

<br/>

## 🚀 快速开始

### 用 Docker（推荐）

```bash
git clone https://github.com/BeckY824/daedalus-crm.git && cd daedalus-crm
docker compose up -d
```

### 或者本地跑（Node 22+）

```bash
git clone https://github.com/BeckY824/daedalus-crm.git && cd daedalus-crm
npm install && npm run setup && npm run dev
```

打开 **http://localhost:3000**，用演示账号登录：

| 用户名 | 密码 | 身份 |
|---|---|---|
| `admin` | `admin123` | 管理员 |
| `zhangsan` | `admin123` | 销售「张三」（演示） |
| `lisi` | `admin123` | 销售「李四」（演示） |

登录后到「设置管理 → 修改密码」把密码改掉。就这些。

- **想用 AI**：管理员进「设置管理 → AI 接入」，填接口地址、API Key、模型名，点「测试连接」。不填就没有 AI 入口，其余功能照常
- **不是教培**：「设置管理 → 业务配置」里把「学员」改成「客户」、「院校 / 年级 / 专业」改成你的字段名，全站同步
- **HTTPS、升级、备份**：见 [docs/部署.md](docs/部署.md)

### 托管版试用

不想自己部署，用邮箱在 [app.ai-daedalus.com/signup](https://app.ai-daedalus.com/signup) 一分钟开出自己的工作区——邮箱、验证码、密码、团队名，没有别的门槛。7 天全功能，到期只读、数据不删。AI 对话注册送 30 次，用了之后每天再送 3 次。
忘了密码在登录页点「忘记密码？」自助找回，不用找我们。

### 桌面客户端

Mac 版（Apple 芯片）**自带一整套服务**：装完直接用，数据是你机器上的一个文件，
不需要服务器、不需要注册。

要用 AI 有两条路：在菜单里登录一个云端账号（注册送 30 次，登录窗里就能点去注册、
也能直接改密码），或者在「设置管理 → AI 接入」填自己的模型 API Key——
填了就完全不走我们的额度，Key 加密存在这台机器上，只发给你自己填的那个接口地址。
设置页会写清楚当前走的是哪一条、还剩几次。

团队要共用一份数据时，在菜单里切到「连接服务器」，指向你们自己部署的实例。
Windows 与 Intel Mac 的包还没有，那两种机器先用自部署版。

安装、放行与更新见 [docs/桌面端安装.md](docs/桌面端安装.md)；实现见 [desktop/README.md](desktop/README.md)；
官网要提供的下载页与版本信息见 [docs/网站对接.md](docs/网站对接.md)。

<br/>

## ✨ 核心能力

### 首页是一个 agent，不是一个搜索框

交互照 Claude Code / Codex：Enter 发送，正在答时再问自动排队，Esc 打断。背后是一个 ReAct 循环，模型自己决定调哪个只读工具——搜客户、读档案、查指标、看盯盘清单——每次调用一行看得见，答完折成一句摘要。回答逐字流出，句末圆标能点回那条记录。多轮有上下文，「他呢」「那再约一下」接得住。

### AI 提议，你拍板

让它改状态、改档案、记跟进、排计划、新建线索 / 商机 / 签约、改渠道——它给一张**建议卡**，字段就地可改，模型不知道的留空让你补，点确认才写进去。落库走的是和界面完全相同的 server action：查重、成环检查、归属重算、留痕一个都不绕过。每次确认记一条 `ai_apply` 日志。

### 记录页三栏

左边档案点一下就能改；中间一条时间线；顶部速记框粘一段聊天，AI 整理成记录、待办、下次计划，你核对后保存，原文留存供后续简报引用；右侧 AI 常驻，打开谁它已读完谁。

### 推荐归属，一条清晰的规则

外部渠道 → 学员 → 学员转介绍，归属取往上两代、不足两代取链条顶端；渠道负责人整条链继承。归属在录入时固化：**改上游推荐人、换渠道负责人，都不追溯改写已有学员的业绩**——没动他的数据，他的归属就不变。个别登记错误在他档案里单独订正。

### 托管版底座（可选）

同一份代码，`MULTI_TENANT=1` 打开多租户：一个工作区一个 SQLite 文件，物理隔离；邮箱验证码注册、自助找回密码、7 天试用、到期只读、订阅与运营台、AI 免费次数账本（注册送 30、每天送 3）。自部署版不开这个开关，一行相关代码都不会执行。

### 模型无关，按人切换

设置页配一张可选模型清单（可从接口拉取），首页输入框下面就能切，每个人各选各的。推理模型的「始终思考」与 token 预算问题已自动处理。

<br/>

## 🧩 适用场景

| 场景 | 怎么用 |
|---|---|
| **教培 / 留学招生** | 默认措辞就是它：学员、院校、年级、专业、渠道老师、转介绍归属 |
| **任何小团队销售** | 「设置管理 → 业务配置」改术语，全站同步；线索 → 客户 → 商机管道通用 |
| **自托管、数据敏感** | 一个容器、一个 SQLite 文件，备份就是复制一个文件；AI 只读不写 |
| **不想部署** | 托管版：邮箱注册，一分钟一个独立工作区 |

<br/>

## 🖼️ 界面

| 客户列表 | 客户详情（三栏） |
|---|---|
| ![](docs/shots/04-customers.png) | ![](docs/shots/05-customer-detail.png) |

| 商机管道 | 数据看板 |
|---|---|
| ![](docs/shots/08-pipeline.png) | ![](docs/shots/02b-overview.png) |

更多截图见 [docs/shots](docs/shots)。

<br/>

## 🛠️ 技术栈

| 层 | 选择 |
|---|---|
| 框架 | Next.js 16 · React 19 · TypeScript 5 |
| 数据 | Prisma 6 · SQLite（一库一文件，托管版一工作区一文件） |
| 界面 | Ant Design 6 · motion |
| AI | OpenAI 兼容接口，ReAct 循环，工具全部只读；DeepSeek / OpenAI / Ollama / 中转站均可 |
| 测试 | vitest（529 单测）· Playwright（58 自部署 + 13 托管版 e2e）· CI 全绿才能合并 |
| 交付 | Docker 多架构镜像（GHCR）· Electron 桌面端（macOS，Apple 芯片）· Caddy 自动 HTTPS |

<br/>

## 🗺️ 路线图

按「有人真的需要了再做」的顺序排，想推动某一项就[开 issue](https://github.com/BeckY824/daedalus-crm/issues) 说清你的场景。完整版见 [ROADMAP.md](ROADMAP.md)。

| 方向 | 内容 | 状态 |
|---|---|---|
| 对话面与建议卡 | agent 循环、流式回答、引用回跳、多轮上下文、7 种建议卡 | ✅ 已发布 |
| 记录页三栏 | 档案行内编辑、时间线、速记解析、AI 常驻 | ✅ 已发布 |
| 托管版底座 | 多租户、注册与免费额度、试用、订阅、运营台、桌面端 | ✅ 已发布 |
| 列表页 | 行内编辑、可保存的视图、筛选 chip、右侧滑出面板 | 🔜 计划中 |
| ⌘K 与全站动画 | 命令面板承接「问一位 / 问一个数 / 跳转」 | 🔜 计划中 |
| 在线支付 | 微信 / 支付宝（需备案与商户号） | ⏸ 视需求 |

<br/>

## 🤝 参与贡献

欢迎 issue 和 PR。开发、测试、提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)；给 AI 编码助手看的约定在 [AGENTS.md](AGENTS.md)。

<a href="https://github.com/BeckY824/daedalus-crm/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=BeckY824/daedalus-crm" alt="contributors" />
</a>

<br/>

## 🔒 安全

发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

<br/>

## 📄 许可证

[AGPL-3.0](LICENSE)：自托管随便用、随便改；改了并对外提供服务，要公开改动。

<br/>

## 🌐 社区与联系

- 官网：[ai-daedalus.com](https://ai-daedalus.com)
- 免费试用：[app.ai-daedalus.com/signup](https://app.ai-daedalus.com/signup)
- 问题与建议：[GitHub Issues](https://github.com/BeckY824/daedalus-crm/issues)
- 商务与试用：[预约演示](https://ai-daedalus.com/demo.html) · qy1g18@gmail.com

<br/>

## ⭐ Star History

<a href="https://star-history.com/#BeckY824/daedalus-crm&Date">
  <img src="https://api.star-history.com/svg?repos=BeckY824/daedalus-crm&type=Date" alt="Star History" width="600" />
</a>
