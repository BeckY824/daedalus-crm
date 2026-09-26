# Windows 桌面版

与 Mac 版使用同一套 Electron + Next.js + SQLite 代码。默认本地模式，先登录云端账号；业务数据保存在本机，账号和 AI 网关使用原有服务器。设置中的「连接服务器」可切换到团队实例，应用菜单可切回本机数据。

## 安装与数据

- [下载 Windows x64 0.46.5 安装包](https://github.com/BeckY824/daedalus-crm/releases/download/desktop-updates/Daedalus-CRM-0.46.5-x64-setup.exe)，发布于现有 `desktop-updates` 滚动 Release。包的校验值与验收情况见 [Windows验证记录.md](Windows验证记录.md)。
- 当前目标为 Windows x64，安装包名为 `Daedalus-CRM-<版本>-x64-setup.exe`。
- 安装向导可选择安装目录。程序包含运行时，无需额外安装 Node 或数据库。
- 数据根目录默认是 `%APPDATA%\DaedalusCRM`，账号数据在 `accounts\<账号哈希>` 下。
- 升级与卸载保留数据。备份通过「设置 → 桌面端」导出一致的 SQLite 数据库。
- 标题栏使用 Windows 原生按钮；快捷键显示 Ctrl。
- 暂未配置代码签名证书，安装程序没有发布者签名。

## 构建与验证

在 Windows x64、Node 22.18+ 环境中，从仓库根目录执行：

```powershell
npm ci
cd desktop
npm ci
npm run dist:win
node scripts/smoke-windows.mjs
```

产物在 `desktop/dist/`。冒烟脚本启动 `win-unpacked/Daedalus CRM.exe`，使用隔离数据目录和本地云端接口替身，验证登录、业务页面、备份、连接服务器、切回本地及重启。不会使用真实云端账号或调用收费模型。也可传入已安装程序的绝对路径。

若 electron-builder 解压 winCodeSign 时提示无法创建 `darwin` 符号链接，这是构建机的符号链接权限限制，可在启用开发者模式的构建机或 GitHub Windows runner 上构建；与用户安装应用无关。

## 更新协议

Windows 使用 NSIS 整包更新：检查版本 → 用户点击下载 → SHA-256 校验 → 用户点击重启 → 停止本地服务 → 启动安装器。安装器覆盖程序并重启，数据位于独立目录。Mac 保持原有差量更新。

官网 feed 保留现有 Mac 顶层字段，增加独立的 Windows 条目：

```json
{
  "version": "0.46.5",
  "dmg": "https://example.com/mac.dmg",
  "platforms": {
    "win32-x64": {
      "version": "0.46.6",
      "url": "https://example.com/download.html",
      "exe": "https://example.com/Daedalus-CRM-0.46.6-x64-setup.exe",
      "sha256": "替换为安装包的64位十六进制SHA256",
      "notes": "本次更新说明",
      "size": "150 MB"
    }
  }
}
```

Windows 不读取旧 feed 的 Mac 版本，也不使用 Mac 安装包的哈希。GitHub 正式 Release 可作为备用源，资产须遵循 `*-x64-setup.exe` 命名；补丁版仍进入现有滚动 Release，因此补丁更新需同步官网 feed。缺少哈希时仅提供手动下载入口，不执行安装器。

官网及 feed 位于另一个仓库，本仓库的适配不会自动发布官网改动。

## 协作者确认的发布约定（2026-09-26 记录）

来源：用户转交的协作者截图。下面的约定用于后续 Windows 发版；截图中的线上版本状态是协作者当时的说明，本次仅记录，未重新核查线上状态。

- 补丁版本（例如 0.46.5，最后一位不为 0）不单独创建 Release。安装包上传到名为「桌面端更新包（滚动）」、tag 为 `desktop-updates` 的滚动 Release；它标记为预发布，不占据 Latest。
- 正式版本（例如 0.47.0，最后一位为 0）单独创建正式 Release。采用这个节奏是为了避免频繁创建 Release 刷关注者动态；往已有 Release 追加资产不会产生同样的发布通知。
- 版本 tag 与独立 Release 是两回事：存在 `v0.46.5` tag，不代表应有一个独立的 0.46.5 Release。
- 桌面更新主源是官网 `https://ai-daedalus.com/desktop/latest.json`。GitHub 的 Latest 标签不代表用户能收到的最新桌面补丁，不能据此判断客户端没有更新。
- 截图说明：当时 0.46.3、0.46.4、0.46.5 的安装包在滚动 Release 下，Latest 仍为 0.46.0；官网 feed 和下载按钮已经指向 0.46.5，下载优先国内镜像、GitHub 备用。
- Windows 沿用这一发布节奏，补齐自身平台条目、安装包和校验值；不能因为 Mac 已发布同版本，就认为本地生成的 Windows 安装包也已上传或上线。

用户已验证本地 Windows 安装包及真实 AI 功能，随后授权将同一安装包上传到滚动 Release 并添加 README 下载入口。本次未修改远端 feed。
