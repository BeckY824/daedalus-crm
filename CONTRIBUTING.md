# 参与开发

## 起环境

```bash
npm install
npm run setup   # 生成 Prisma Client、建表、灌入演示账号
npm run dev
```

打开 http://localhost:3000，`admin` / `crm@2026`（开发库的默认密码；Docker 部署首启会随机生成）。测试说明见 [docs/测试.md](docs/测试.md)。

## 跑测试

```bash
npm test           # 单元 + Server Action，约 5 秒
npm run test:e2e   # Playwright，自起 dev server，约 5 分钟
npm run test:ai    # AI 验收，真的调模型（要 key、花钱），需先 npm run dev -- --port 3100
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
