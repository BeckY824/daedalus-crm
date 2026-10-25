# 企业版部署手册

一台服务器、一家公司、一份数据。全部数据在贵司自己的服务器上，我们不保留任何副本。

部署包里有：

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | 应用 + HTTPS 入口（Caddy）。不要直接改，升级时会换新 |
| `Caddyfile` | HTTPS 配置。不要直接改 |
| `.env.example` | 配置样例。安装时生成 `.env`，可调的都在 `.env` 里 |
| `scripts/` | 安装、备份、恢复、升级、回滚、状态检查脚本 |
| `VERSION` | 这个部署包对应的版本号 |

以下命令都在部署目录里执行（推荐放在 `/opt/crm-enterprise`），都要 `sudo`。

---

## 一、准备服务器

**配置**：2 核 CPU、4 GB 内存、40 GB 硬盘起步，Ubuntu 22.04 或 24.04（x86_64）。
20–30 人日常使用这个配置足够；附件多的话硬盘按实际放大。

**网络**：

1. 域名：准备一个子域名（例如 `crm.贵司域名.com`），添加一条 **A 记录** 指向服务器的公网 IP。
2. 端口：在云服务器的安全组 / 防火墙里放行 **80** 和 **443**（TCP，入方向）。
   80 端口用于自动申请证书和跳转到 HTTPS，不要关。

**安装 Docker**（服务器上执行一次）：

```bash
curl -fsSL https://get.docker.com | sudo sh
```

国内服务器下载慢时加镜像源：

```bash
curl -fsSL https://get.docker.com | sudo sh -s -- --mirror Aliyun
```

装好后确认：

```bash
sudo docker compose version
```

能打出版本号即可。

---

## 二、安装

我们会发给贵司（或贵司从我们给的地址下载）：

- `crm-enterprise-<版本>.tar.gz`：部署包
- `crm-images-<版本>.tar.gz`：离线镜像包（服务器不能直接拉镜像时用；国内服务器推荐用它）
- 两个包各自的 `.sha256` 校验文件，和包放在同一目录

### 1. 解压部署包

```bash
sudo tar -xzf crm-enterprise-<版本>.tar.gz -C /opt
cd /opt/crm-enterprise
```

### 2. 执行安装

**离线安装（推荐）**：把镜像包和它的 `.sha256` 上传到服务器，然后：

```bash
sudo ./scripts/install.sh --load /path/to/crm-images-<版本>.tar.gz --domain crm.贵司域名.com
```

**在线安装**（服务器能访问 ghcr.io 时）：

```bash
sudo ./scripts/install.sh --domain crm.贵司域名.com
```

安装脚本会依次：

1. 检查服务器配置、磁盘空间、Docker；
2. （离线时）校验并导入镜像；
3. 生成 `.env` 和管理员初始密码；
4. **生成备份密码**——屏幕上只显示这一次，见「五、备份与恢复」，务必当场抄走；
5. 启动应用，等健康检查通过；
6. 装好每天 03:30 的自动备份；
7. 打印访问地址和管理员账号密码（**只显示一次**）。

安装脚本重复执行是安全的：已有的 `.env`、备份密码、数据都不会被覆盖。

### 3. 第一次登录

浏览器打开 `https://crm.贵司域名.com`，用 `admin` 和安装时显示的密码登录，然后：

1. 「设置管理 → 修改密码」，把初始密码改掉；
2. 在设置里添加成员账号、设置部门和上下级；
3. 填 AI Key（见「七、AI 接入」）。

---

## 三、日常

| 要做的事 | 命令 |
| --- | --- |
| 看整体状态（版本、健康、最近备份、证书、磁盘） | `sudo ./scripts/status.sh` |
| 看应用日志 | `sudo docker compose logs -f --tail 200 crm` |
| 看 HTTPS 入口日志 | `sudo docker compose logs -f --tail 200 caddy` |
| 重启 | `sudo docker compose restart` |
| 停止 / 启动 | `sudo docker compose down` / `sudo docker compose up -d` |

`docker compose down` 只停容器，**数据不会丢**（数据在 Docker 数据卷里）。
**千万不要**执行 `docker compose down -v` 或 `docker volume rm`：`-v` 会把数据卷一起删掉。

服务器重启后应用会自动起来，不需要人工操作。

建议每周看一眼 `status.sh`：最近备份超过 2 天、磁盘快满时它会提示。

---

## 四、HTTPS 证书

### 默认：自动申请

不用做任何事。Caddy 会自动向 Let's Encrypt 申请证书，到期前自动续期。

前提：域名的 A 记录已经指向本机，80 和 443 能从公网访问。
证书申请失败时看 `sudo docker compose logs caddy`，最常见的原因是 DNS 还没生效或安全组没放行 80。

### 用贵司自己的证书

公司已有通配符证书、或者内网部署不能访问公网时：

1. 把证书文件放进部署目录的 `certs/`：
   - `certs/cert.pem`：证书，**要包含中间证书链**（证书商一般叫 fullchain / 完整链）
   - `certs/key.pem`：私钥，不能带密码
2. 执行：

   ```bash
   sudo ./scripts/use-own-cert.sh
   ```

脚本会先核对证书和私钥是否配对、是否过期、是否包含 `.env` 里的域名，通过后立即生效，不用重启。

证书续期后：覆盖这两个文件，再执行一次 `use-own-cert.sh`。

改回自动申请：

```bash
sudo ./scripts/use-own-cert.sh --auto
```

---

## 五、备份与恢复

### 备份密码（最重要）

备份文件用 AES-256 加密，密码是安装时生成的，存在服务器上的 `secrets/backup.pass`。

- **安装时请把屏幕上显示的备份密码抄下来，存到服务器以外**：公司密码管理器，或打印出来放保险柜。
- 我们**拿不到**这个密码，也**没有办法**帮贵司解开备份。服务器坏了、硬盘丢了的时候，只有这份密码能解开异地备份。
- 想换密码：`sudo ./scripts/backup-password.sh --force`。旧密码会留在 `secrets/` 里（文件名带 `.old-` 和时间），换之前的备份要用旧密码解。

### 自动备份

安装后每天 03:30 自动备份一次，备份的是全部数据：数据库、附件、登录会话密钥。

- 位置：部署目录下的 `backups/crm-<时间>.tar.gz.enc`
- 默认保留最近 30 份，在 `.env` 里改 `BACKUP_KEEP`
- 日志：`/var/log/crm-backup.log`
- 手动备份一次：`sudo ./scripts/backup.sh`
- 升级、恢复之前脚本会自动先备一份

**强烈建议另存一份到别的盘**：备份和数据放在同一块盘上，盘坏了会一起丢。
挂载另一块云盘或 NAS（例如挂到 `/mnt/backup`），然后在 `.env` 里写：

```
BACKUP_COPY_DIR=/mnt/backup/crm
```

先 `sudo mkdir -p /mnt/backup/crm`，之后每次备份都会自动复制一份过去，同样按 `BACKUP_KEEP` 保留。

### 恢复

```bash
sudo ./scripts/restore.sh                                      # 用最新一份
sudo ./scripts/restore.sh backups/crm-20261027-033000.tar.gz.enc   # 用指定的一份
```

恢复会**覆盖当前全部数据**，脚本会要求输入 `RESTORE` 确认。步骤是：

1. 先解密、校验这份备份（坏的备份不会动现有数据）；
2. 把当前数据再备一份（万一恢复错了还能回来）；
3. 停应用 → 换数据 → 启动 → 等健康检查。

恢复后所有人的账号密码、登录状态都回到备份那一刻。

### 换一台服务器恢复（异地恢复）

1. 新服务器按「一、准备服务器」「二、安装」装好**同一个版本**（或更新的版本）；
2. 把备份文件拷到新服务器；
3. 把备份密码写进一个文件，例如 `/root/backup.pass`（只写密码一行），然后：

   ```bash
   sudo BACKUP_PASS_FILE=/root/backup.pass ./scripts/restore.sh /path/to/crm-xxxx.tar.gz.enc
   ```

4. 恢复完成后，把 `/root/backup.pass` 移到 `secrets/backup.pass`（以后的备份继续用同一个密码），或者执行 `backup-password.sh --force` 换新密码。
5. 域名 A 记录改指向新服务器。

### 恢复演练

建议上线前和之后每季度演练一次：在一台测试机上按「异地恢复」的步骤恢复最近一份备份，登录确认数据完整。
这是唯一能确认「备份真的能用、密码真的没丢」的办法。

---

## 六、升级与回滚

升级前我们会在自己的测试机上用同样的流程验证过，再通知贵司。

### 升级

**离线（推荐）**：上传新版本的镜像包和 `.sha256`，然后：

```bash
sudo ./scripts/upgrade.sh --load /path/to/crm-images-<新版本>.tar.gz
```

**在线**：

```bash
sudo ./scripts/upgrade.sh <新版本号>
```

脚本会：先备份 → 导入 / 拉取新镜像 → 重启 → 等健康检查且版本号对上。
新版本 5 分钟内没起来会**自动退回原版本**，数据不动。重启通常不到 1 分钟（不含导入镜像），期间无法访问，建议在下班后进行。

### 新版本同时带了新的部署包时

我们会说明这一版要不要换部署包。要换时，在升级之前把新部署包解压到同一位置：

```bash
sudo tar -xzf crm-enterprise-<新版本>.tar.gz -C /opt
```

这只会换掉 `docker-compose.yml`、`Caddyfile`、`scripts/`、手册等文件；
`.env`、`secrets/`、`backups/`、`certs/` 里的证书和全部数据都不会动。然后照常执行上面的升级命令。

### 回滚

```bash
sudo ./scripts/rollback.sh
```

退回到升级前的那个版本。数据库升级只加表加列，旧版本可以直接用升级后的数据。
如果要连数据一起退回到升级前（一般不需要），用升级时屏幕上打印的那份备份恢复：

```bash
sudo ./scripts/restore.sh backups/crm-<升级时的时间>.tar.gz.enc
```

---

## 七、AI 接入

AI 功能使用贵司自己的 AI 服务 Key，费用由贵司直接和 AI 服务商结算。两种填法，二选一：

1. **界面里填（推荐）**：管理员登录后到「设置 → AI 接入」，填接口地址、API Key、模型。
2. **写在 `.env` 里**：

   ```
   LLM_API_KEY=sk-...
   LLM_BASE_URL=https://接口地址/v1
   LLM_MODEL=模型名
   ```

   改完执行 `sudo docker compose up -d` 生效。界面里填过的优先于 `.env`。

Key 只保存在贵司服务器上。

---

## 八、故障排查

先跑 `sudo ./scripts/status.sh`，大部分问题从这里能看出来。

| 现象 | 排查 |
| --- | --- |
| 浏览器打不开 / 连接超时 | 安全组是否放行 80、443；`sudo docker compose ps` 两个容器是否都是 Up |
| 证书错误 / 不安全提示 | `sudo docker compose logs caddy` 看证书申请日志；DNS 是否已指向本机（`ping 域名` 看 IP）；用自有证书时确认 `cert.pem` 带了中间证书链 |
| 页面显示 502 | 应用还在启动（首次或升级后等 1 分钟），或应用出错：`sudo docker compose logs --tail 200 crm` |
| 忘了管理员密码 | 见下方「重置管理员密码」 |
| 磁盘快满 | `sudo docker images` 看旧版本镜像，`sudo docker rmi ghcr.io/becky824/daedalus-crm:<旧版本>` 删掉（**保留当前和上一版**，回滚要用）；减小 `BACKUP_KEEP`；附件多就扩容硬盘 |
| 自动备份没在跑 | `cat /var/log/crm-backup.log` 看报错；`ls /etc/cron.d/crm-backup` 不存在就重跑 `install.sh` |
| 页面偶尔报「数据库忙」、或想排查是不是多连接引起的 | `.env` 里加一行 `CRM_READ_POOL=0`，`sudo docker compose up -d`：查询回到单连接（会慢一些，功能不变）。查完删掉这行再 `up -d` 恢复 |
| 首页的统计数（活跃、建档、沉睡客户）和刚改的数据对不上 | 正常情况下改完下一次刷新就是新数（最多旧 30 秒）。确认是缓存的问题：`.env` 里加一行 `CRM_HOME_CACHE=0`，`sudo docker compose up -d`：首页每次现数（会慢一些，功能不变）。查完删掉这行再 `up -d` 恢复 |

**重置管理员密码**（会把 `admin` 的密码改成你指定的值）：

```bash
sudo docker compose exec -e RESET_PASSWORDS=1 -e INIT_PASSWORD='新密码' crm node seed.js
```

需要我们协助时，请把 `status.sh` 的输出和 `sudo docker compose logs --tail 300 crm` 的输出一起发给我们。
**不要**发 `.env`、`secrets/` 里的内容或备份密码。
