# 企业版部署手册

一台服务器、一家公司、一份数据。全部数据在贵司自己的服务器上，我们不保留任何副本。

部署包里有：

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | 应用 + HTTPS 入口（Caddy）。不要直接改，升级时会换新 |
| `Caddyfile` | HTTPS 配置。不要直接改 |
| `.env.example` | 配置样例。安装时生成 `.env`，可调的都在 `.env` 里 |
| `scripts/` | 安装、备份、恢复、升级、回滚、状态检查、导出根证书脚本 |
| `tools/smoke.sh` | 装好后的冒烟检查：管理员登录 → 加成员 → 成员登录 → 健康检查 |
| `VERSION` | 这个部署包对应的版本号 |

以下命令都在部署目录里执行（推荐放在 `/opt/crm-enterprise`），都要 `sudo`。

---

## 一、准备服务器

**配置**：

| | CPU | 内存 | 硬盘 | 系统 |
| --- | --- | --- | --- | --- |
| 建议 | 4 核 | 8 GB | 100 GB | Ubuntu 22.04 或 24.04（x86_64） |
| 最低 | 2 核 | 4 GB | 40 GB | 同上 |

最低配置够 20–30 人日常使用；附件多、要留较多备份的话硬盘按实际放大。

**访问地址**（二选一）：

1. **域名（推荐）**：准备一个子域名（例如 `crm.贵司域名.com`），添加一条 **A 记录** 指向服务器的 IP。
   证书自动向 Let's Encrypt 申请，浏览器直接信任。
2. **IP**：没有域名、只在内网用时，直接用服务器的 IPv4 地址（例如 `10.0.0.8`）。
   证书由内置 CA 自签，浏览器第一次会提示不受信任，见「四、HTTPS 证书」。

**网络**：

1. 端口：在安全组 / 防火墙里放行 **22**（SSH，给运维登录）、**80** 和 **443**（TCP，入方向）。
   80 端口用于自动申请证书和跳转到 HTTPS，不要关。
2. 出网：服务器要能访问 `open.feishu.cn`（飞书同步要用）。在线安装还要能访问 `ghcr.io`；用离线镜像包就不需要。

**我们上门 / 远程部署时需要的权限**：

- 一个能 `sudo` 的账号，**只用 SSH 公钥登录**（不用密码）：我们把公钥发给贵司，贵司 IT 加到这个账号的 `~/.ssh/authorized_keys` 里；
- 上面三个端口已放行；
- 部署完成后贵司随时可以删掉这行公钥，收回权限。

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

**没有域名、用 IP 访问**：`--domain` 后面直接写服务器 IP（员工从哪个地址访问就写哪个）：

```bash
sudo ./scripts/install.sh --load /path/to/crm-images-<版本>.tar.gz --domain 10.0.0.8
```

不带 `--domain` 时脚本会问「域名或 IP」，填哪种都行；带了 `https://`、端口、路径会自动去掉。暂不支持 IPv6 地址。

安装脚本会依次：

1. 检查服务器配置、磁盘空间、Docker；
2. （离线时）校验并导入镜像；
3. 生成 `.env` 和管理员初始密码；
4. **生成备份密码**——屏幕上只显示这一次，见「五、备份与恢复」，务必当场抄走；
5. 启动应用，等健康检查通过；
6. 装好每天 03:30 的自动备份；
7. 打印访问地址和管理员账号密码（**只显示一次**）。

用 IP 装时，第 3 步之后还会写 `certs/tls.caddy`（`tls internal`），改由内置 CA 签发证书。

安装脚本重复执行是安全的：已有的 `.env`、备份密码、数据都不会被覆盖。

### 冒烟检查（装完马上跑一次）

```bash
sudo ./tools/smoke.sh
```

提示输入 admin 密码（不回显），然后依次检查：健康检查 → 管理员登录 → 加一个叫「冒烟测试」的销售成员 → 这个成员登录、打开首页 → 停用这个成员 → 再查一次健康。
全部通过最后一行是「✅ 冒烟通过」；哪一步不通过会写明是哪一步、返回了什么，退出码非 0。
密码不会出现在屏幕和日志里。测试成员测完即停用，名下没有数据；设置里的成员列表会多一条已停用的「冒烟测试」，不用管。

### 3. 第一次登录

浏览器打开 `https://crm.贵司域名.com`，用 `admin` 和安装时显示的密码登录，然后：

1. 「设置管理 → 修改密码」，把初始密码改掉；
2. 在设置里添加成员账号、设置部门和上下级；
3. 填 AI Key（见「七、AI 接入」）；
4. 需要按角色锁字段的话：「设置 → 组织架构 → 字段权限」点「用推荐表」→ 按贵司实际调整 → 保存，再打开「字段权限」规则。不开规则时谁都能改。

### 4. 组织规则的默认值

装好后所有组织规则**都是关的**：「设置 → 组织架构」里的「按组织看客户」「线索分配」「字段权限」，「设置 → 项目」里的公海持有上限、超时回收、节点推进。不打开时，组织只是一张人员表，和普通团队版一样用。要用哪条由老板账号单独打开，打开后没另行配置的都按下面的默认做法：

| 规则 | 默认做法 |
| --- | --- |
| 超时回收 | 按日历天算，周末、节假日不顺延；除了有人打开首页 / 项目页时扫，每天 00:05 再定时扫一次，同一天只收一次 |
| 订单项目 | 不进公海。离职时选「放回公海」，订单项目连同它的客户一起交给接手人，客户不进客户公海 |
| 直属上级 | 能往前推节点，也能退回、定结果、标异常（异常只在订单阶段能标）；每一次都记节点日志 |
| 既是直属又是虚线上级 | 权限取两者的并集（按直属算），操作照样记日志 |
| 离职交接的线索 | 「线索分配」打开时，交给接手人的线索记一行分配记录，不算进接手人当月的分配数 |

**节点必填**（「设置 → 项目 → 节点推进」）默认也是关的。要打开时，老板点「用建议清单」再保存，就是下面这套默认配置：

| 阶段 | 节点 | 必填 |
| --- | --- | --- |
| 线索 | 潜客培育 | 联系方式、来源、本节点沟通、下一步时间 |
| 线索 | 线索验证 | 主联系人、国家、客户等级、需求（项目备注） |
| 线索 | 线索推进 | 金额 |
| 商机 | 明确需求 | 需求（项目备注）、预计成交日期、主联系人 |
| 商机 | 共识方案 | 下一步时间、本节点沟通 |
| 商机 | 成交推进 | 金额、预计成交日期 |
| 商机 | 签约审批 | 不设，人工推进 |
| 商机 | 签订合同、首款支付 | 暂不设：合同、首款到账这类字段系统里还没有，贵司确认清单后再加 |
| 订单 | 生产备货、物流运输 | 暂不设：采购单、物流单据这类字段系统里还没有，贵司确认清单后再加 |
| 订单 | 安装实施 | 不设（不需要安装的订单也要能过） |
| 订单 | 验收交付 | 验收通过 |

填齐一个节点的必填项，项目自动推到下一个节点；销售本人不能手动往前推配了必填的节点，找直属上级。往后退照旧，已经填过的不清。

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

证书有三种来源，`sudo ./scripts/status.sh` 的「HTTPS 证书」一行会写现在用的是哪种。

### 用域名：自动申请（默认）

不用做任何事。Caddy 会自动向 Let's Encrypt 申请证书，到期前自动续期。

前提：域名的 A 记录已经指向本机，80 和 443 能从公网访问。
证书申请失败时看 `sudo docker compose logs caddy`，最常见的原因是 DNS 还没生效或安全组没放行 80。

内网域名（公网访问不到、申请不了 Let's Encrypt）又没有自己的证书时，可以和 IP 一样改用内置 CA：
`echo 'tls internal' | sudo tee certs/tls.caddy && sudo docker compose restart caddy`，后面同下一节。

### 用 IP：内置 CA 自签

公网证书机构不给 IP 发证书，所以用 IP 装时由 Caddy 自带的 CA 签发，自动续期，不用管。三件事要知道：

**1. 浏览器会提示不受信任。** 第一次打开 `https://<IP>` 时 Chrome / Edge 显示「您的连接不是私密连接」，Safari 显示「此连接非私人连接」。
临时可以点「高级 → 继续前往」，但每台电脑、每个浏览器都会再问；正式使用请做第 2 步或第 3 步。

**2. 让员工电脑信任根证书（装一次就不再提示）。** 在服务器上导出根证书：

```bash
sudo ./scripts/export-root-cert.sh
```

得到部署目录下的 `crm-root-ca.crt`（公开的根证书，不含私钥，可以发给员工），屏幕上同时打出它的 SHA-256 指纹。
把文件和指纹一起发给员工，装之前核对指纹一致：

- **Windows**：双击 `crm-root-ca.crt` →「安装证书」→ 存储位置选「本地计算机」→「将所有的证书都放入下列存储」→ 浏览选「**受信任的根证书颁发机构**」→ 完成。
  或者用管理员身份打开命令提示符：`certutil -addstore -f Root crm-root-ca.crt`。批量下发可以用域控组策略。
- **Mac**：双击 `crm-root-ca.crt` 加到「系统」钥匙串 → 在「钥匙串访问」里找到它（名字是 Caddy Local Authority）→ 双击 →「信任」→「使用此证书时」选「**始终信任**」，输入开机密码保存。
  或者终端：`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain crm-root-ca.crt`。
- 装完**重开浏览器**。Firefox 有时用自己的证书库：设置里搜「证书」→「查看证书」→「证书颁发机构」→ 导入。

注意：根证书跟着服务器上的 Caddy 数据走。**换服务器、或者 Caddy 数据被清掉后会生成新的根证书**，要重新导出、员工重新装（旧的可以删掉）。

**3. 或者换成贵司自己的证书**：贵司有内部 CA、或者买了带 IP 的证书时，按下一节「用贵司自己的证书」换上，证书里要包含这个 IP。

### 用贵司自己的证书

公司已有通配符证书、或者内网部署不能访问公网时：

1. 把证书文件放进部署目录的 `certs/`：
   - `certs/cert.pem`：证书，**要包含中间证书链**（证书商一般叫 fullchain / 完整链）
   - `certs/key.pem`：私钥，不能带密码
2. 执行：

   ```bash
   sudo ./scripts/use-own-cert.sh
   ```

脚本会先核对证书和私钥是否配对、是否过期、是否包含 `.env` 里的域名（用 IP 时核对 IP），通过后立即生效，不用重启。

证书续期后：覆盖这两个文件，再执行一次 `use-own-cert.sh`。

改回默认（域名 → 自动申请；IP → 内置 CA 自签）：

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

先跑 `sudo ./scripts/status.sh`，大部分问题从这里能看出来；再跑一次 `sudo ./tools/smoke.sh`，看是哪一步不通。

### 去哪里看日志

| 看什么 | 命令 |
| --- | --- |
| 整体状态：版本、健康、最近备份、证书、磁盘、时钟 | `sudo ./scripts/status.sh` |
| 两个容器起没起来 | `sudo docker compose ps -a` |
| 应用日志（报错、启动失败、数据库） | `sudo docker compose logs --tail 300 crm`（加 `-f` 持续看） |
| HTTPS 入口日志（证书申请、502） | `sudo docker compose logs --tail 300 caddy` |
| 每日备份日志 | `sudo tail -100 /var/log/crm-backup.log` |
| 定时备份有没有装 | `cat /etc/cron.d/crm-backup` |

以上命令都在部署目录（`/opt/crm-enterprise`）里执行。

### 常见现象

| 现象 | 排查 |
| --- | --- |
| 浏览器打不开 / 连接超时 | 安全组是否放行 80、443；`sudo docker compose ps` 两个容器是否都是 Up |
| 证书错误 / 不安全提示 | 用 IP 访问时这是正常的，见「四」装根证书；用域名时 `sudo docker compose logs caddy` 看证书申请日志，DNS 是否已指向本机（`ping 域名` 看 IP）；用自有证书时确认 `cert.pem` 带了中间证书链 |
| 装过根证书后又提示不受信任 | 服务器换过、或 Caddy 数据被清过，根证书变了：重新 `export-root-cert.sh`，员工重新装 |
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
