# 存量库的增量迁移

全新安装不走这里：容器首次启动时用构建期生成的 `schema.sql` 一次性建全表。
这个目录管的是**已经有数据的库**——加了新表之后，让线上那份库也补上。

## 规则

1. 文件按 `NNN-简短说明.sql` 命名，按文件名顺序执行
2. **每条语句都必须幂等**：`CREATE TABLE IF NOT EXISTS`、
   `CREATE INDEX IF NOT EXISTS`。容器每次启动都会把整个目录重跑一遍，
   不记录「执行到哪了」——少一套状态就少一处会对不上的地方
3. 因此**只能加东西，不能改也不能删**。SQLite 的 `ALTER TABLE` 能力本来就弱，
   真要改表结构，走 `REBUILD_DB=1`（会先备份）而不是往这里塞
4. 加了新表记得同步改 `prisma/schema.prisma`，否则全新安装那条路径会缺表

## 为什么不用 prisma migrate

`prisma migrate deploy` 需要在运行镜像里带上 Prisma CLI，而它的依赖树很难裁干净
（Dockerfile 里为此专门绕开了）。这张表的需求只是「加一张只增不改的表」，
用 Node 内置的 `node:sqlite` 执行几条幂等 SQL 就够，不值得为此把镜像撑大。
