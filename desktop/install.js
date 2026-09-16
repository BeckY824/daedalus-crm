/**
 * 应用内更新的安装部分：下载 dmg → 校验 → 把新的 .app 换到旧的位置 → 由调用方重启。
 *
 * **为什么自己写而不用 electron-updater**：它在 macOS 上走 Squirrel.Mac，要求新旧两个包
 * 是同一张 Developer ID 证书签的。我们决定不买开发者账号（2026-09-16 拍板），只有 ad-hoc
 * 签名，Squirrel 必然拒绝，而且是静默失败。自己换文件没有这个限制——新包自己的签名完整就能起。
 *
 * 一个顺带的好处：由应用自己下载、复制出来的文件**不带 quarantine 属性**。
 * Gatekeeper 只在用户第一次从浏览器装的时候拦一次，之后每次应用内更新都不再弹。
 *
 * 换包的顺序（任何一步失败都退得回去）：
 *   1. hdiutil 挂载 dmg（只读、不弹 Finder 窗口）
 *   2. codesign --verify 新包 —— 下载截断、镜像损坏都在这一步被抓住，而不是换完才发现起不来
 *   3. ditto 复制到旧包旁边的 X.app.new（同一个卷，后面的 rename 才是原子的）
 *   4. 旧包 rename 成 X.app.old
 *   5. X.app.new rename 成 X.app          ← 失败就把 .old 改回来
 *   6. 卸载 dmg。.old **不在这里删**：现在跑着的进程就是从它里面起的，
 *      删了再拉起 helper 会找不到文件；留给下次启动的 清理旧包()
 *
 * 不引 electron：全是 node 内置模块，能直接拿 node 测。执行外部命令的函数可注入。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

function 默认运行(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} 失败：${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/** 从可执行文件路径推出 .app 包的路径。不在 .app 里（开发态 `electron .`）返回 null */
function 解析应用包(exePath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(exePath));
  return m ? m[1] : null;
}

function 目录可写(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 这个位置能不能原地换包。不能就返回原因，调用方退回「去下载页」。
 * - 从 dmg 里直接双击运行的（路径在 /Volumes 下）：只读卷，而且用户根本还没装
 * - 所在目录没有写权限：/Applications 归 root 而用户不是管理员的机器
 */
function 能原地更新(bundle, { platform = process.platform, 可写 = 目录可写 } = {}) {
  if (platform !== "darwin") return { ok: false, 原因: "只有 macOS 支持应用内更新" };
  if (!bundle) return { ok: false, 原因: "不是打包后的应用" };
  if (bundle.startsWith("/Volumes/")) return { ok: false, 原因: "应用还在安装镜像里运行。先把它拖进「应用程序」再更新" };
  if (!可写(path.dirname(bundle))) return { ok: false, 原因: `没有权限改写 ${path.dirname(bundle)}` };
  return { ok: true };
}

/**
 * 下载到文件，边下边报进度。用 Node 22 自带的 fetch，流式落盘，不把 160 MB 读进内存。
 * 先写到 .part，下完且大小对得上才改名——半截文件不会被当成完整的。
 */
async function 下载文件({ url, 目标, sha256 = null, 进度 = () => {}, fetch: f = globalThis.fetch }) {
  // 上次下完没装（比如直接退出了）：文件还在、哈希对得上，就不再下一遍 160 MB
  if (sha256 && fs.existsSync(目标)) {
    try {
      await 校验sha256(目标, sha256);
      进度(1, 1);
      return 目标;
    } catch {
      await fsp.rm(目标, { force: true });
    }
  }
  const res = await f(url, { redirect: "follow", headers: { "User-Agent": "DaedalusCRM-Desktop" } });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  const 总 = Number(res.headers.get("content-length")) || null;
  await fsp.mkdir(path.dirname(目标), { recursive: true });
  const 临时 = `${目标}.part`;
  const out = fs.createWriteStream(临时);
  let 已下 = 0;
  try {
    for await (const chunk of res.body) {
      已下 += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      进度(已下, 总);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (总 !== null && 已下 !== 总) throw new Error(`下载不完整：${已下} / ${总} 字节`);
  } catch (e) {
    out.destroy();
    await fsp.rm(临时, { force: true });
    throw e;
  }
  await fsp.rename(临时, 目标);
  return 目标;
}

/** 文件的 sha256 要和发布记录里的一致——GitHub 给每个 Release 资产都算了一份 */
async function 校验sha256(file, 期望) {
  const 期望值 = String(期望).replace(/^sha256:/, "").toLowerCase();
  const h = crypto.createHash("sha256");
  for await (const c of fs.createReadStream(file)) h.update(c);
  const 实际 = h.digest("hex");
  if (实际 !== 期望值) {
    throw new Error(`校验失败：下载的文件和发布的不是同一个（sha256 ${实际.slice(0, 12)}… ≠ ${期望值.slice(0, 12)}…）`);
  }
}

/**
 * 把 dmg 里的应用换到 目标 的位置。目标是现在正在运行的那个 .app。
 * 返回后调用方应立刻重启；.old 留给下次启动的 清理旧包()。
 */
async function 安装dmg({ dmg, 目标, 运行 = 默认运行, 日志 = () => {} }) {
  const 目录 = path.dirname(目标);
  const 名 = path.basename(目标);
  const 新 = path.join(目录, `${名}.new`);
  const 旧 = path.join(目录, `${名}.old`);
  await fsp.rm(新, { recursive: true, force: true });
  await fsp.rm(旧, { recursive: true, force: true });

  const 挂载点 = await fsp.mkdtemp(path.join(os.tmpdir(), "daedalus-update-"));
  日志(`挂载 ${dmg}`);
  await 运行("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-noautoopen", "-noverify", "-mountpoint", 挂载点]);
  try {
    const 包 = (await fsp.readdir(挂载点)).filter((n) => n.endsWith(".app"));
    if (包.length !== 1) throw new Error(`安装镜像里应该正好有一个应用，实际 ${包.length} 个`);
    const 来源 = path.join(挂载点, 包[0]);
    日志("校验新包的签名");
    await 运行("codesign", ["--verify", "--strict", "--deep", 来源]);
    日志("复制到应用程序文件夹");
    await 运行("ditto", [来源, 新]);
  } finally {
    await 运行("hdiutil", ["detach", 挂载点, "-force"]).catch(() => {});
    await fsp.rm(挂载点, { recursive: true, force: true }).catch(() => {});
  }

  日志("换包");
  await fsp.rename(目标, 旧);
  try {
    await fsp.rename(新, 目标);
  } catch (e) {
    await fsp.rename(旧, 目标).catch(() => {}); // 退回去，用户手上还是能用的旧版
    throw e;
  }
  return 目标;
}

/** 上次更新留下的 .old / .new，启动时清掉。删不掉也不报错，下次再试 */
async function 清理旧包(目标) {
  if (!目标) return;
  await fsp.rm(`${目标}.old`, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(`${目标}.new`, { recursive: true, force: true }).catch(() => {});
}

module.exports = { 解析应用包, 能原地更新, 下载文件, 校验sha256, 安装dmg, 清理旧包 };
