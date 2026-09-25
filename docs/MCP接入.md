# 让别的 agent 连进来（MCP）

这个 CRM 平时做的事是**我们去调模型**（OpenAI 兼容的 chat/completions）。
这一条是反过来的：**别人的 agent 来调我们**——Claude Code、Codex、Claude 桌面端
把这套 CRM 当成一个工具箱，用他们自己的订阅和模型来查你的客户本。

协议是 [MCP](https://modelcontextprotocol.io)，传输走 streamable HTTP，端点是 `/api/mcp`。

对一个人用的场景意义最大：那个人多半已经在付 Claude 或 ChatGPT 的钱、已经在用
Codex 或 Claude Code。接上之后他在那边问「张三最近跟进到哪了」，用的是**他自己**的额度，
而数据一步不出他的机器——我们送的那点免费次数在这条线上根本不需要。

## 怎么接

1. 打开 **设置 → AI 接入**，拉到底，点「生成接入令牌」
2. 把那一整条命令复制到终端里执行：

   ```bash
   claude mcp add --transport http daedalus http://127.0.0.1:3717/api/mcp \
     --header "Authorization: Bearer dcrm_……"
   ```

   Codex 用 `codex mcp add`，参数一样。

3. 在 Claude Code 里 `/mcp` 能看到 `daedalus`，然后就可以直接问：

   > 「我目前有哪些渠道，哪个带来的客户最多？」
   > 「张三这条线最近跟进到哪了？」
   > 「这个月签约金额按销售分一下」

## 能做什么、不能做什么

开出去的是**十四个只读工具**：

| 工具 | 干什么 |
|---|---|
| `search_customers` | 按关键词找客户 |
| `get_customer` | 一位客户的全景：档案、商机、待办、下次计划、完整跟进时间线 |
| `find_person` | 按名字找一个人，不知道他是客户、渠道、联系人、线索还是同事时用；返回电话和身份 |
| `query_metric` | 业务指标（线索数、转化率、客户数、签约额、签约单数、跟进次数），可按月 / 销售 / 渠道等分组 |
| `get_watchlist` | 盯盘：正在被遗忘的客户 |
| `get_my_plans` | 我未完成的跟进计划 |
| `my_recap` | 我这一段时间做了什么：跟了谁、记了几笔、签了几单 |
| `list_channels` | 渠道清单：负责人、带来多少客户、链上签约额 |
| `list_leads` | 线索清单 |
| `list_opportunities` | 商机清单，默认只列进行中的 |
| `list_contracts` | 签约记录，可按时间段、客户、销售、渠道过滤 |
| `list_users` | 工作区里的人：岗位、角色、手上多少客户 |
| `query_records` | 通用查询：按条件找记录、排序、计数、分组统计（表和字段都在白名单里，取数有上限） |
| `search_followups` | 跨客户按关键词搜跟进记录 |

**写入一个都没有。** 记一笔、改状态、排计划、建商机仍然只能在 CRM 里点——
「AI 只起草，人点确认才落库」这条规矩不能因为换了个入口就失效。
我们这边的 agent 用的是「建议卡」（`propose_*`）：它产出一张要人点确认的卡片，
而 MCP 客户端里没有那张卡，直接把它接出去等于把规矩从后门绕掉。
等建议卡能持久化了，会作为一组 `propose_*` 工具开出去，人在 CRM 里确认。

## 令牌

- 一个库一把，存在设置表里（和 AI 配置同一张表），只有管理员能生成和看见
- **不是**桌面端那枚登录令牌：那枚能换一张会话票据，这枚只能调上面十四个查询
- 重新生成会让旧的立刻失效——钥匙抄给了不该给的人时只有这一条路
- 生成令牌的那个人被停用，这把钥匙一起作废
- 令牌走 `Authorization: Bearer`，**不放地址栏**：地址会进 shell 历史、进日志、进截图

## 端口为什么是 3717

桌面端的本地服务每次启动换一个随机空端口，而 MCP 客户端那边配的是一行写死的地址。
所以壳里另开了一条**只转 `/api/mcp`** 的薄桥，固定监听 3717（被占就往后找，
实际落在哪个端口写在数据目录的 `mcp.json` 里，设置页显示的就是它）。
只听 127.0.0.1，别的路径一律 404——这是个长期开着的口子，能转的东西越少越好。

自部署的网页版端口本来就是固定的，没有这个问题，直接用 `你的地址/api/mcp`。

**托管版（app.ai-daedalus.com）不提供这个接口**：那边是多租户，一个 URL 背后好几个
工作区，而这条协议里没有工作区这个概念。它是给桌面端和自部署的。

## 实现在哪

| | |
|---|---|
| 协议消息 | `src/lib/mcp/rpc.ts`（initialize / tools/list / tools/call / ping） |
| 工具与 JSON Schema | `src/lib/mcp/tools.ts` |
| 令牌 | `src/lib/mcp/token.ts` |
| HTTP 端点 | `src/app/api/mcp/route.ts` |
| 固定端口的桥 | `desktop/mcp-bridge.js` |

没有用官方 SDK：这一层加起来不到两百行，而 SDK 会把一套传输、会话、能力协商的抽象
带进桌面端的打包体积里。真到了要做 sampling / resources 那天再换不迟。
