# 参与开发

## 起环境

```bash
npm install
npm run setup   # 生成 Prisma Client、建表、灌入演示账号
npm run dev
```

打开 http://localhost:3000，`admin` / `admin123`（开发库与 compose 的默认密码）。测试说明见 [docs/测试.md](docs/测试.md)。

代码怎么分、想加一个 AI 工具 / 行业预设 / 模型接入 / 列表页该改哪几个文件，见 [docs/架构.md](docs/架构.md)。

## 跑测试

```bash
npm test           # 单元 + Server Action，约 5 秒
npm run test:e2e   # Playwright，自起 dev server，约 5 分钟
npm run test:ai    # AI 验收，真的调模型（要 key、花钱），需先 npm run dev -- --port 3100
npm run test:team  # 团队版五台真实对齐（本机云端 + 5 台桌面端），约 1 分钟；产物旧了先自动 build:server。见 scripts/team-sim/README.md
```

提交前的自动关卡（每台机器一次）：

```bash
git config core.hooksPath hooks
```

之后 `git push` 会先跑 `tsc --noEmit`、`eslint`、`vitest run`。CI 上会再跑一遍加上 E2E 与 gitleaks。

## 几条纪律

- **迁移只增不改不删**：`migrations/*.sql` 每条语句幂等，容器每次启动全量重跑。规则见 `migrations/README.md`。
- **AI 只起草不落库**：模型输出一律当不可信输入，经清洗后由人确认再走原有 Server Action 保存。
- **少即是多**：新功能优先复用现有交互，不加设置项、不加入口。宁可砍功能也不加复杂度。
- 提交信息写"为什么"，不写"改了什么"——后者 diff 里有。
