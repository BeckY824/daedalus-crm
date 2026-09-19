# 存量库的增量迁移

全新安装不走这里：容器首次启动时用构建期生成的 `schema.sql` 一次性建全表。
这个目录管的是**已经有数据的库**——加了新表之后，让线上那份库也补上。

## 规则

1. 文件按 `NNN-简短说明.sql` 命名，按文件名顺序执行
2. **每条语句都必须幂等**：`CREATE TABLE IF NOT EXISTS`、
   `CREATE INDEX IF NOT EXISTS`。容器每次启动都会把整个目录重跑一遍，
   不记录「执行到哪了」——少一套状态就少一处会对不上的地方
3. 因此**只能加东西，不能改也不能删**：加表、加索引、加列。
   改列类型、改约束、删任何东西都不行——真要改表结构，走 `REBUILD_DB=1`（会先备份）
4. `ALTER TABLE ... ADD COLUMN` 是第 2 条的唯一例外，因为 SQLite 没有
   `ADD COLUMN IF NOT EXISTS`：第二次执行必然抛 `duplicate column name`。
   所有 runner 都把这一句（和 `already exists`）当预期跳过：
   `docker-entrypoint.sh` 四处、`desktop/server-entry.js`、`scripts/build-template.mjs`。
   **加列的迁移单独一个文件、只放 ADD COLUMN**（配套的 `CREATE INDEX IF NOT EXISTS`
   可以同文件）：一旦和别的语句混在一起，那一句抛出来就把同文件后面的全跳过了。
   例子见 `006-ai-conversation-scope.sql`
5. 加了新表或新列记得同步改 `prisma/schema.prisma`，否则全新安装那条路径会缺表缺列

## 为什么不用 prisma migrate

`prisma migrate deploy` 需要在运行镜像里带上 Prisma CLI，而它的依赖树很难裁干净
（Dockerfile 里为此专门绕开了）。这张表的需求只是「加一张只增不改的表」，
用 Node 内置的 `node:sqlite` 执行几条幂等 SQL 就够，不值得为此把镜像撑大。
