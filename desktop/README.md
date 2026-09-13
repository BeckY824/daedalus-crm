# 桌面客户端

一个 Electron 外壳，把 Daedalus CRM 装进 Dock / 任务栏。数据和逻辑都在服务器上，
这里只有一个窗口、一个可改的服务器地址、和断网时的一句人话提示。

托管版用户装完直接用；自部署的人在「服务器设置」里填自己的地址，同一个安装包通用。

## 打包

```bash
cd desktop && npm install
npm run dist:mac     # 出 dmg（universal，Intel 与 Apple 芯片通用）
npm run dist:win     # 出 exe 安装包
```

产物在 `desktop/dist/`。

Windows 包在 macOS 上交叉打包不稳，用 GitHub Actions 的 `desktop.yml` 两个平台各打各的。

## 关于签名

**现在不签名。** 代价是每个人第一次打开要手动放行一次：

- macOS：右键点图标 → 打开 → 再点「打开」；或系统设置 → 隐私与安全性 → 「仍要打开」
- Windows：SmartScreen 拦截时点「更多信息」→「仍要运行」

要去掉这一步，两边都得花钱：macOS 需要 Apple 开发者账号（99 美元/年）做签名与公证，
Windows 需要代码签名证书。等有足够多的人在用再买，下载页把放行步骤写清楚就够。

## 不做自动更新

没签名的 macOS 应用没法用 electron-updater 自动更新。现在是启动时加载远程页面，
所以**功能更新会自动生效**，只有外壳本身（窗口、菜单）需要重新下载，这种改动很少。
