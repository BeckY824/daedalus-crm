# 企业版升级：我方操作手册

> 【我方用，不发给客户】`tools/` 不进交付包（`pack.sh` 只打 compose、Caddyfile、`scripts/`、README）。
> 客户手册里的「六、升级与回滚」写的是客户自己怎么升；这里写我们怎么先在测试机验证、再去客户服务器升级。
> 原则：**测试机没走通的版本不上客户服务器**；客户服务器上执行的命令和测试机上的是同一套 `scripts/`。

## 0. 测试机（一次性准备）

- 和客户服务器同样的系统（Ubuntu 22/24）、Docker、同一份部署包，装在 `/opt/crm-enterprise`。
- 版本**和客户服务器保持一致**：客户在跑哪个版本，测试机就停在哪个版本。每次验证完测试机会停在新版本，正好接上下一次。
- 数据用样例数据（导入一份样例 Excel、建几个部门和账号、几条客户和跟进），**不放客户的真实数据**。
- 域名用我们自己的测试子域名，或者 `DOMAIN=localhost`（Caddy 自签证书，脚本自动不校验证书）。

## 1. 出版本

1. 正式版本打 `v*` tag，`release.yml` 把镜像推到 GHCR（amd64 + arm64）。
2. 打交付包：

   ```bash
   deploy/enterprise/tools/pack.sh 0.47.0      # 产出 dist/enterprise-0.47.0/ 下的部署包、离线镜像包和 .sha256
   ```

3. 看 CHANGELOG 和这一版的改动，记下：要不要换部署包（compose、Caddyfile、`scripts/` 有没有改）、有没有要客户配合的事。

## 2. 测试机验证

1. 把离线镜像包和 `.sha256` 传到测试机（部署包有改动的话，先照客户手册「新版本同时带了新的部署包时」解压覆盖）。
2. 跑验证脚本（用和给客户的同一个镜像包）：

   ```bash
   sudo deploy/enterprise/tools/verify-upgrade.sh --load /root/crm-images-0.47.0.tar.gz
   ```

   它会：升级 → 回滚 → 再升级，每一步都经 HTTPS 核版本、开登录页、核数据库每张表都在且行数没少，
   核心业务表（客户、联系人、跟进、合同…）按起点时的列算的内容哈希三次都和起点一样。
   测试机库是空的会直接拒绝（空库验不出数据丢没丢）：加 `FILL=1` 先灌演练数据，或先导入样例数据。
   新版本有意改了某张核心表的旧数据（数据迁移）时用 `CORE_SKIP="表名"` 跳过，发版说明里写清楚。
   通过时在 `/opt/crm-enterprise/verify-upgrade.log` 记一行。
3. 浏览器上手动点一遍（5 分钟）：管理员登录、客户列表和详情、写一条跟进、组织架构设置页、线索分配、导入页面能打开；用一个销售账号登录看自己的客户。
4. 任何一步不对：**不去客户服务器**。修好重新出版本，测试机先 `sudo ./scripts/rollback.sh` 退回客户在用的版本，再验一次。

## 3. 客户服务器升级

1. 先和客户约时间：下班后，告诉对方大约几分钟访问不了。
2. 传离线镜像包和 `.sha256`（要换部署包的话一起传，先解压覆盖）。
3. 升级前看一眼，确认最近一次备份是成功的：

   ```bash
   cd /opt/crm-enterprise && sudo ./scripts/status.sh
   ```

4. 升级（脚本先自动备份，新版本 5 分钟内没起来会自动退回原版本）：

   ```bash
   sudo ./scripts/upgrade.sh --load /root/crm-images-0.47.0.tar.gz
   ```

   屏幕上会打印升级前那份备份的文件名，记下来。
5. 升完：`sudo ./scripts/status.sh` 看版本；浏览器打开客户域名的登录页，管理员登录看一眼。
6. 有问题：
   - 程序有问题、数据没问题：`sudo ./scripts/rollback.sh`，退回上一版，数据保留。
   - 数据也要退回升级前（一般不需要）：`sudo ./scripts/restore.sh backups/crm-<升级时的时间>.tar.gz.enc`。
7. 告诉客户升好了、这一版改了什么。客户服务器上的镜像保留当前和上一版（回滚要用），更早的可以删。

## 4. 恢复演练（测试机，每次出版本前 + 每月一次）

备份没恢复过就不算有备份。测试机上（**会清空数据卷，别在客户服务器上跑**）：

```bash
sudo deploy/enterprise/tools/restore-drill.sh --fill   # 刚装好、库里没数据时先灌演练数据
sudo deploy/enterprise/tools/restore-drill.sh          # 测试机上已经有样例数据时
```

它会：停应用拍整个数据卷的指纹（每张表行数 + 内容哈希、表结构、附件哈希）→ `backup.sh` 备份、把备份和密码拷出去
（模拟异地）→ 五种坏备份（截断、中间改一个字节、密码不对、随机字节、没有数据库的包）必须被 `restore.sh` 拒绝且数据不动
→ `docker compose down -v`、删掉本机备份和密码 → 只拿异地那份恢复，指纹必须一模一样 → 启动、HTTPS 检查。
通过时在 `/opt/crm-enterprise/restore-drill.log` 记一行（含从清空到能用的秒数）。

## CI 里已经自动验的

`.github/workflows/enterprise-deploy-verify.yml` 每次改部署包、Dockerfile、入口脚本都会在干净的 Ubuntu 上跑，
用这次代码打一份和给客户一样的交付包（`tools/pack.sh`），然后两组各跑三遍，三遍都绿才算过：

- **升级演练**：先装 GHCR 上最新发布的版本，先灌演练数据，再用离线镜像包跑 `FILL=1 verify-upgrade.sh`（升级、回滚、再升级，三次核心表内容哈希相等），
  再验「新版本起不来时自动退回」，最后 HTTPS、企业版开关、状态脚本。
- **安装 + 恢复演练**：解开交付包，`install.sh --load` 一条命令装好（计时，超过 30 分钟算失败），
  再跑 `restore-drill.sh --fill`（上面第 4 节那一套）。

CI 过了只说明脚本和镜像没问题，**不能代替测试机**：测试机的系统、网络、证书和样例数据更接近客户服务器。
