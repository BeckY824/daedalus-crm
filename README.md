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

[官网](https://ai-daedalus.com) · [下载桌面端](https://ai-daedalus.com/download.html) · [部署文档](docs/部署.md) · [路线图](ROADMAP.md) · [反馈](https://github.com/BeckY824/daedalus-crm/issues)

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
- ✅ AI 从不自己动手：任何一次模型调用都要你点，页面加载不触发（免费额度按次算，不该被界面替你花掉）
- ✅ 界面只剩两栏：左边导航永远在，右边是正文；只有学员记录页多一列名单（要在一堆人之间连着切的时候）
- ✅ 键盘能到的地方不用鼠标：⌘K 跳转与提问、⌘, 设置、⌘1–9 切模块
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

登录后点左下角账号菜单 →「设置 →登录与密码」把密码改掉。就这些。

- **想用 AI**：管理员进「设置 → AI 接入」（设置在左下角账号菜单里，或按 ⌘,），填接口地址、API Key、模型名，点「测试连接」。不填就没有 AI 入口，其余功能照常
- **不是教培**：「设置 → 业务配置」里把「学员」改成「客户」、「院校 / 年级 / 专业」改成你的字段名，全站同步
- **HTTPS、升级、备份**：见 [docs/部署.md](docs/部署.md)

### 网页试用版

不想装任何东西，先看看长什么样：[app.ai-daedalus.com](https://app.ai-daedalus.com) 是**一个共享的试用工作区**，
装着一套演示数据，账号密码通过[预约演示](https://ai-daedalus.com/demo.html)或邮件找我们要。
里面是大家共用的，别录真实客户。

[app.ai-daedalus.com/signup](https://app.ai-daedalus.com/signup) 注册的是**云端账号**，给桌面端用（记 AI 次数），
不会开出一个网页工作区。想要自己的数据，装桌面端或自部署。

### 桌面客户端

Mac 版（Apple 芯片）**自带一整套服务**：装完直接用，数据是你机器上的一个文件，不需要服务器。
第一次打开是应用里的登录页，**用邮箱注册一个免费账号**（注册在浏览器里办，找回密码在应用内）；
账号只用来记 AI 次数，数据不上传。更新是**差量**的：改了什么下什么，不是每次重下一整个包。

AI 有两条路：用账号自带的免费次数（注册送 30 次，每天登录再补 3 次），
或者在「设置 → AI 接入」填自己的模型 API Key——
填了就完全不走我们的额度，Key 加密存在这台机器上，只发给你自己填的那个接口地址。
设置页会写清楚当前走的是哪一条、还剩几次。

团队要共用一份数据时，在菜单里切到「连接服务器」，指向你们自己部署的实例。
Windows 与 Intel Mac 的包还没有，那两种机器先用自部署版。

安装、放行与更新见 [docs/桌面端安装.md](docs/桌面端安装.md)；实现见 [desktop/README.md](desktop/README.md)；
官网要提供的下载页与版本信息见 [docs/网站对接.md](docs/网站对接.md)。

<br/>

## ✨ 核心能力

### 界面：导航永远在，其余服从任务

左栏 220px 常驻，八个模块的名字直接写出来（不靠悬停）。**中栏不是默认栏位**——
只有「要在同类记录之间连着切」的场景才出现，眼下全站只有学员记录页那一处窄名单；
一个模块两个视图（商机的管道 / 列表、跟进的计划 / 记录）用页头按钮切，不值得占一列。
左栏右边那条缝可以拖，宽度这台机器记得住。设置不是一页而是**一层浮层**，盖在你正看的东西上面，
Esc 关掉回到原处。桌面端再把系统标题栏去掉，红黄绿钮嵌进左栏顶上。

按下去的东西会缩一下再弹回来，换页淡进来，弹框居中——系统开了「减弱动态效果」则一处位移都没有。

### 首页是一个 agent，不是一个搜索框

交互照 Claude Code / Codex：Enter 发送，正在答时再问自动排队，Esc 打断。背后是一个 ReAct 循环，模型自己决定调哪个只读工具——搜客户、读档案、查指标、看盯盘清单——每次调用一行看得见，答完折成一句摘要。回答逐字流出，句末圆标能点回那条记录。多轮有上下文，「他呢」「那再约一下」接得住。

### AI 提议，你拍板

让它改状态、改档案、记跟进、排计划、新建线索 / 商机 / 签约、改渠道——它给一张**建议卡**，字段就地可改，模型不知道的留空让你补，点确认才写进去。落库走的是和界面完全相同的 server action：查重、成环检查、归属重算、留痕一个都不绕过。每次确认记一条 `ai_apply` 日志。

### 记录页：档案、时间线、按需的 AI

左边档案点一下就能改；中间一条时间线；顶部速记框粘一段聊天，AI 整理成记录、待办、下次计划，你核对后保存，原文留存供后续简报引用。右侧是 AI 栏，**打开页面它不会自己去问模型**——点「生成简报」才读这一位的全部跟进，按钮旁边写着它要花掉几次额度。删一条跟进记录也不弹框，那颗删除键自己变成「删除这条？删除 / 取消」。

### 推荐归属，一条清晰的规则

外部渠道 → 学员 → 学员转介绍，归属取往上两代、不足两代取链条顶端；渠道负责人整条链继承。归属在录入时固化：**改上游推荐人、换渠道负责人，都不追溯改写已有学员的业绩**——没动他的数据，他的归属就不变。个别登记错误在他档案里单独订正。

### 托管版底座（可选）

同一份代码，`MULTI_TENANT=1` 打开多租户：一个工作区一个 SQLite 文件，物理隔离；邮箱验证码注册、自助找回密码、订阅与运营台、AI 免费次数账本（注册送 30、每天送 3）。我们线上用它跑一个共享试用工作区和桌面端的云端账号。自部署版不开这个开关，一行相关代码都不会执行。

### 模型无关，按人切换

设置页配一张可选模型清单（可从接口拉取），首页输入框下面就能切，每个人各选各的。推理模型的「始终思考」与 token 预算问题已自动处理。

<br/>

## 🧩 适用场景

| 场景 | 怎么用 |
|---|---|
| **教培 / 留学招生** | 默认措辞就是它：学员、院校、年级、专业、渠道老师、转介绍归属 |
| **任何小团队销售** | 「设置 → 业务配置」改术语，全站同步；线索 → 客户 → 商机管道通用 |
| **自托管、数据敏感** | 一个容器、一个 SQLite 文件，备份就是复制一个文件；AI 只读不写 |
| **不想部署** | 桌面端：装完就用，数据在你机器上；或先去共享试用工作区看看 |

<br/>

## 🖼️ 界面

| 客户列表 | 客户详情 |
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
| 测试 | vitest（645 单测）· Playwright（98 自部署 + 13 托管版 e2e）· CI 全绿才能合并 |
| 交付 | Docker 多架构镜像（GHCR）· Electron 桌面端（macOS，Apple 芯片）· Caddy 自动 HTTPS |

<br/>

## 🗺️ 路线图

按「有人真的需要了再做」的顺序排，想推动某一项就[开 issue](https://github.com/BeckY824/daedalus-crm/issues) 说清你的场景。完整版见 [ROADMAP.md](ROADMAP.md)。

| 方向 | 内容 | 状态 |
|---|---|---|
| 对话面与建议卡 | agent 循环、流式回答、引用回跳、多轮上下文、7 种建议卡 | ✅ 已发布 |
| 记录页 | 档案行内编辑、时间线、速记解析、按需简报 | ✅ 已发布 |
| 界面与手感 | 可拖宽的左栏、设置浮层、⌘K / ⌘, / ⌘1–9、全站按下即有回应 | ✅ 已发布 |
| 托管版底座 | 多租户、注册与免费额度、试用、订阅、运营台、桌面端 | ✅ 已发布 |
| 可保存的视图 | 一组筛选存成一个视图，下次一点就回来 | 🔜 计划中 |
| 列表页行内编辑 | 不进详情页就能改一格 | 🔜 计划中 |
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
