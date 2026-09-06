# 测试

```bash
npm test               # 单元 + Server Action，约 5 秒
npm run test:e2e       # Playwright E2E，自起 dev server，约 5 分钟
npm run test:e2e:prod  # 同上，但跑生产构建（next build + next start）
npm run test:ai        # AI 验收：真的调模型，要 key、花钱；需先 npm run dev -- --port 3100
```

两套都自带环境准备：单元测试跑在 `prisma/test.db`（`tests/setup-db.ts` 建表），
E2E 跑在 `prisma/e2e.db`（`e2e/global-setup.ts` 每轮重建并写入账号）。都不碰开发库。
清库顺序统一在 `tests/reset.ts`，加了新表只改这一处。

## 单元测试覆盖什么

| 文件 | 覆盖 |
|---|---|
| `attribution` | 推荐归属算法全分支（门禁要求 100% 覆盖，`npm run test:coverage`） |
| `actions` / `concurrency` / `stress` | **直接调真实的 Server Action**：级联、查重窗口、字段级合并、五人并发。并发闸门成立与否取决于判断和写入是否同一条语句，绕过 action 就测不到 |
| `security` | 登录限流、`X-Forwarded-For` 取最后一段、错误页不外泄 |
| `csv` | 导出的编码、RFC 4180 转义、公式注入 |
| `audit` / `migrations` / `guards` | 操作留痕、迁移只增不改的护栏、修复项的回归锁 |
| `settings` | 键值缓存与失效、API Key 加解密、业务配置回退、AI 配置两级读取 |
| `ai-draft` / `ai-quota` / `ai-actions` / `sentinel` / `referral` / `report-query` | AI 输出清洗、配额、未配 key 时的降级、盯盘与雷达的纯规则、问数据的查询规格校验 |

## E2E 覆盖什么

| 文件 | 覆盖 |
|---|---|
| `smoke` | 线索 → 学员 → 跟进 → 签约主链路 + CSV 导出 |
| `multiuser` | 跨会话可见性、批量操作交叉、同账号多设备与在线停用 |
| `duplicate` | 手机号查重预警与硬拦、成员登录名 / 姓名重复 |
| `quick-channel` | 新建学员时就地建渠道 |
| `security` | 存储型 XSS、登录限流 |
| `business-settings` | 改术语后侧边栏与表头同步；AI 接入页校验 |
| `ui-walkthrough` | 空状态、校验可见性、窄屏与手机视口、分页、后退 |
| `console-audit` | 遍历所有页面，控制台任何 error / warning 即失败 |

E2E 套件串行执行（`workers: 1`），用例之间按业务链条前后依赖，测的正是"链条通不通"。

## 已知行为（不是 bug）

- 客户端路由缓存 60 秒：别人的改动最多滞后 60 秒出现在已缓存页面；自己的改动立即可见
- 管理员不出现在负责人下拉，与业绩排行榜口径一致
- 删除被他人当作推荐人的学员会被拒绝——删了下游业绩归属就成了孤儿
