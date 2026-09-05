# 部署与运维

一个实例一个团队。数据是一份 SQLite 文件，放在 Docker 卷里，归你自己。

## 一、Docker 单机（推荐）

需要 Docker 24+（自带 `docker compose`）。

```bash
git clone https://github.com/<你>/daedalus-crm.git && cd daedalus-crm
cp .env.example .env
```

编辑 `.env`，至少填两项：

```
AUTH_SECRET=<openssl rand -base64 48 的输出>
INIT_PASSWORD=<管理员初始密码，至少 8 位>
```

然后：

```bash
docker compose up -d --build
```

不想在这台机器上构建（小内存服务器跑 Next 构建会 OOM），改用预构建镜像：把 `docker-compose.yml` 里的
`build: .` 删掉，`image` 改成 `ghcr.io/becky824/daedalus-crm:latest`（或具体版本如 `:0.2.0`；amd64 与 arm64 都有），
再 `docker compose pull && docker compose up -d`。

打开 http://服务器IP:3000，用 `admin` / 你设的 `INIT_PASSWORD` 登录。
AI 功能可选：登录后到「设置管理 → AI 接入」填接口地址、API Key、模型名（任何 OpenAI 兼容接口），不用改配置文件；也可用 `.env` 的 `LLM_*` 变量作兜底。不配则 AI 入口整体隐藏。

**没有 `INIT_PASSWORD` 会拒绝启动**——这是有意的，开源软件不能带默认密码出厂。
库建好之后这个变量就不再被读取，可以从 `.env` 删掉。

首次启动建出三个账号：`admin`（管理员）以及两个演示销售 `zhangsan` / `lisi`，密码都是 `INIT_PASSWORD`。
演示账号用不上就在「设置管理 → 团队成员」停用。

## 二、加 HTTPS（可选）

需要一个已解析到这台机器的域名。没有域名可用 sslip.io 这类通配符 DNS：
`DOMAIN=1.2.3.4.sslip.io` 会直接解析回该 IP，Let's Encrypt 照样签证书。

`.env` 里加：

```
DOMAIN=crm.example.com
COOKIE_SECURE=true
```

用两个 compose 文件叠加启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
```

Caddy 自动申请并续期证书，应用不再直接暴露 3000。

> `COOKIE_SECURE=true` 之后只能通过 https 登录。若仍要保留 http://IP 入口，就必须保持 `false`。

## 三、升级

```bash
git pull
docker compose up -d --build      # 有 Caddy 就带上两个 -f
```

迁移自动跑：容器每次启动会按顺序执行 `migrations/*.sql`，每条语句都幂等（`IF NOT EXISTS`），
所以不记录"执行到哪了"，重跑无副作用。迁移**只增不改不删**，因此旧版本镜像也能跑在新库上，回滚不用动数据。

## 四、备份与恢复

数据库跑在 WAL 模式，**不能直接复制 `crm.db`**——最近的写入还在 `crm.db-wal` 里，直接拷会丢数据。
要用 `VACUUM INTO` 生成一致性快照：

```bash
docker compose exec -T crm node --experimental-sqlite -e "new (require('node:sqlite').DatabaseSync)('/data/crm.db').exec(\"VACUUM INTO '/tmp/snapshot.db'\")"
docker compose exec -T crm cat /tmp/snapshot.db > backup-$(date +%Y%m%d-%H%M%S).db
```

恢复：先停容器，把备份放回卷内改名为 `crm.db`，**同时删掉旧的 `crm.db-wal` / `crm.db-shm`**（不删的话 SQLite 会把旧 WAL 重放到新文件上），再起容器。

```bash
docker compose stop crm
docker compose cp backup.db crm:/data/crm.db
docker compose run --rm --no-deps --entrypoint sh crm -c 'rm -f /data/crm.db-wal /data/crm.db-shm'
docker compose up -d crm
```

`scripts/backup.sh` 与 `scripts/restore.sh` 把上面两段封装成了远程版（经 SSH 操作另一台机器），
用法：`CRM_HOST=root@your-server ./scripts/backup.sh`。

## 五、清空数据重来

不可逆，先备份：

```bash
docker compose exec -T -e CONFIRM=RESET -e INIT_PASSWORD=新密码 crm node reset-data.js
```

## 六、账号维护

登录用**用户名**，不是邮箱。日常增删成员在「设置管理 → 团队成员」做。
`prisma/seed.ts` 里的 `USERS` 是首启名单，改了它可以在容器里重跑同步（不动密码）：

```bash
docker compose exec -T crm node seed.js
docker compose exec -T -e RESET_PASSWORDS=1 -e INIT_PASSWORD=xxx crm node seed.js   # 顺带重置名单内账号的密码
docker compose exec -T -e PRUNE_ACCOUNTS=1 crm node seed.js                          # 停用名单外的空账号
```

## 七、表结构变更

修改 `prisma/schema.prisma` 后，存量库需要一条幂等迁移放进 `migrations/`（规则见 `migrations/README.md`）。
真要重建表结构，用 `REBUILD_DB=1` 启动一次：会先把旧库备份到 `/data/pre-rebuild-<时间>.db` 再重建。

## 八、在另一台机器上构建、经 SSH 部署

小内存服务器（2G）跑 Next 构建会 OOM。`scripts/deploy.sh` 在本机构建镜像、打 git sha 版本 tag、
经 SSH 传到服务器并重启，保留最近 5 个版本可回滚：

```bash
CRM_HOST=root@your-server ./scripts/deploy.sh
# Apple Silicon 给 x86 服务器构建默认已处理；ARM 服务器加 PLATFORM=linux/arm64
```

回滚：`docker tag daedalus-crm:<版本> daedalus-crm:latest && docker compose up -d --no-build`。

## 九、并发与性能

- SQLite 已切 WAL 模式，启动时设 `busy_timeout=5000`，几人到二十人并发够用。恢复备份后确认 `journal_mode` 仍是 `wal`。
- `next.config.ts` 开了 `experimental.staleTimes`（动态页 60 秒客户端缓存）：切回刚看过的页面从秒级变成 0.1 秒。
  代价是别人的改动最多滞后 60 秒出现在已缓存页面；自己的改动会主动 `router.refresh()`，立即可见。
