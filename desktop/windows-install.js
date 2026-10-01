const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { 校验sha256 } = require("./install");

// NSIS 负责等待旧实例退出、覆盖程序、保留数据并重新启动。
// 启动前再次验哈希，避免下载后安装文件被替换。路径不经 shell。
// 传了 更新目录 就记一笔「正在装哪一版、安装程序是哪个进程」，见下面 安装进行中()
async function 启动安装({ 文件, sha256, 更新目录 = null, 版本 = "", 启动 = spawn }) {
  if (!/^[a-f0-9]{64}$/i.test(sha256 || "")) throw new Error("Windows 更新缺少 SHA-256 校验值");
  await 校验sha256(文件, sha256);
  await new Promise((resolve, reject) => {
    const child = 启动(文件, ["/S", "--updated", "--force-run"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      if (更新目录 && child.pid) 记安装中(更新目录, { 版本, pid: child.pid });
      child.unref();
      resolve();
    });
  });
}

/* ---------- Windows 安装进行中（2026-09-29 起） ----------
 *
 * 整包更新用 /S 静默安装：先卸旧版、再往安装目录写两千多个文件，杀毒还要逐个扫，一两分钟里**屏幕上什么都没有**。
 * 用户看着像「点了重启，应用没了」，就去点开它——程序文件才写了一半，本地服务找不到 next 起不来，
 * 弹框里再点「改用服务器」就进了托管版的共享账号：掉登录、每页从香港加载。2026-09-29 Sam 那台就是这么一路走下来的。
 *
 * 所以启动安装程序时记下它的进程号；应用启动时先看这一笔，安装程序还活着就不起本地服务，
 * 等它装完再从新文件重新打开（main.js 的 等安装装完）。记录超过 15 分钟不算数：进程号会被系统复用，
 * 而正常的安装没有那么久。
 */
const 安装中文件 = (更新目录) => path.join(更新目录, "installing.json");
const 安装最久毫秒 = 15 * 60 * 1000;

function 记安装中(更新目录, { 版本 = "", pid, 方式 = "整包", 现在 = Date.now() }) {
  try {
    fs.mkdirSync(更新目录, { recursive: true });
    fs.writeFileSync(安装中文件(更新目录), `${JSON.stringify({ 版本, pid, 方式, at: 现在 })}\n`);
    return true;
  } catch { return false; }
}

function 清掉安装记录(更新目录) {
  try { fs.rmSync(安装中文件(更新目录), { force: true }); } catch { /* 删不掉下次再删 */ }
}

/** 进程还在不在。EPERM 是「在，但不让碰」——也算在 */
function 进程活着(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * 安装程序或差量换目录辅助程序还在跑吗。在跑就返回那一笔；没在跑（装完了、失败了、记录太旧）就删掉记录、返回 null。
 * 只读一个小文件、问一次进程，启动时每次都可以调。
 */
function 安装进行中(更新目录, { 活着 = 进程活着, 现在 = Date.now() } = {}) {
  let 记录 = null;
  try {
    记录 = JSON.parse(fs.readFileSync(安装中文件(更新目录), "utf8"));
  } catch {
    return null;
  }
  const 有效 = Number.isInteger(记录?.pid) && 记录.pid > 0 && Number.isFinite(记录?.at) && 现在 - 记录.at < 安装最久毫秒;
  if (有效 && 活着(记录.pid)) return 记录;
  清掉安装记录(更新目录);
  return null;
}

/* ---------- 差量（2026-09-28 起） ----------
 *
 * 组装和 Mac 共用 delta.js：以已装的目录为基准，没变的硬链接、变了的对 zip 发 Range，
 * 组装到旁边的 <安装目录>.new。和 Mac 不一样的是换的那一步：
 * macOS 上运行中的 .app 可以直接改名；Windows 上运行中的 exe、dll、app.asar 都被锁着，
 * 目录改不了名。所以换目录交给一个 PowerShell 脚本：等应用进程退出 → 旧目录改成 .old
 * （还锁着就每半秒重试，最多 30 秒）→ .new 改到原位 → 改「应用和功能」里的版本号 → 需要的话重新打开。
 * 任何一步不成就把旧目录改回去，用户手上还是能用的旧版；.new/.old 留给下次启动的 清理旧包()。
 *
 * 只在「NSIS 装的、装在自己能写的地方」做：
 *   - 目录里得有 NSIS 放的卸载程序——没有说明是解压版 / 开发态，不归我们换
 *   - 父目录要能写（.new/.old 建在旁边）：装到 Program Files 的是给所有用户装的，
 *     没有管理员权限写不了，那种情况走整包，让安装程序自己去要权限
 */

/** NSIS 放在安装目录根上的卸载程序：「Uninstall Daedalus CRM.exe」（electron-builder 的 UNINSTALL_FILENAME） */
const 是卸载程序 = (名) => /^Uninstall .+\.exe$/i.test(名);

/**
 * 从可执行文件路径推出安装目录。不是 NSIS 装的（没有卸载程序）返回 null。
 * 读目录的函数可注入，测试不用真的造一个 Windows 安装目录。
 */
function 安装目录(exePath, { 列目录 = (d) => fs.readdirSync(d) } = {}) {
  const 目录 = path.win32.dirname(String(exePath || ""));
  // 装在盘符根上（D:\）时 dirname 还是它自己，旁边没有地方放 .new
  if (!目录 || path.win32.parse(目录).root === 目录) return null;
  try {
    return 列目录(目录).some(是卸载程序) ? 目录 : null;
  } catch {
    return null;
  }
}

/**
 * 真去建一个再删掉，建得了才算能写。**不用 fs.accessSync(W_OK)**：它在 Windows 上只看只读属性、不看 ACL，
 * 装在 Program Files 里（普通用户没有写权限）它也说能写——于是差量组装到一半才 EPERM，白下一截。
 */
function 可写(dir) {
  let 探 = null;
  try {
    探 = fs.mkdtempSync(path.join(dir, ".dcrm-probe-"));
    return true;
  } catch {
    return false;
  } finally {
    if (探) try { fs.rmdirSync(探); } catch { /* 删不掉也不影响判断 */ }
  }
}

/** 这个安装目录能不能差量换。不能就说原因，调用方走整包 */
function 能差量更新(目录, { 能写 = 可写 } = {}) {
  if (!目录) return { ok: false, 原因: "不是安装程序装的（没有卸载程序），走整包" };
  const 父 = path.win32.dirname(目录);
  if (!能写(父) || !能写(目录)) return { ok: false, 原因: `没有权限改写 ${父}（可能是给所有用户装的），走整包` };
  return { ok: true };
}

/**
 * 清单里只有 win-unpacked 的东西，NSIS 装的时候还往目录里放了卸载程序（和可能的卸载图标）。
 * 组装出来的 .new 没有它们，换过去之后「应用和功能」里的卸载就找不到文件了——所以从已装的拷过去。
 * 只拷这两样，不拷别的「清单里没有的文件」：那些多半是旧版本留下的，正该借这次清掉。
 */
async function 补齐安装器文件(已装, 目标) {
  const 名们 = (await fsp.readdir(已装)).filter((n) => 是卸载程序(n) || /^uninstallerIcon\.ico$/i.test(n));
  if (!名们.some(是卸载程序)) throw new Error("已装的目录里找不到卸载程序");
  for (const n of 名们) await fsp.copyFile(path.join(已装, n), path.join(目标, n));
  return 名们;
}

/**
 * 换目录的脚本。**只许有 ASCII**：Windows PowerShell 5.1 按系统代码页读没有 BOM 的脚本，
 * 中文注释或路径写进来就是乱码。路径一律从参数传——命令行参数是 UTF-16，中文用户名不受影响。
 */
const 换目录脚本 = `param(
  [Parameter(Mandatory=$true)][string]$Dir,
  [int]$WaitPid = 0,
  [int]$Relaunch = 0,
  [string]$Version = '',
  [string]$Exe = '',
  [string]$Log = '',
  [string]$Handshake = '',
  [int]$Tries = 60
)
$ErrorActionPreference = 'Stop'
function Say([string]$m) {
  if (-not $Log) { return }
  try { Add-Content -LiteralPath $Log -Encoding UTF8 -Value ((Get-Date -Format o) + ' ' + $m) } catch {}
}
function Start-App {
  if ($Relaunch -and $Exe) {
    $p = Join-Path $Dir $Exe
    if (Test-Path -LiteralPath $p) { try { Start-Process -FilePath $p } catch { Say ('relaunch failed: ' + $_) } }
  }
}
$New = $Dir + '.new'
$Leaf = Split-Path -Leaf $Dir
$Old = $Dir + '.old'
Say ('begin ' + $Dir + ' -> ' + $Version + ' wait ' + $WaitPid)
if ($Handshake -and (Test-Path -LiteralPath ($Handshake + '.cancel'))) { Say 'handoff cancelled'; exit 5 }
if (-not (Test-Path -LiteralPath $New)) { Say 'no .new, nothing to do'; if (-not $Handshake) { Start-App }; exit 2 }
if ($Handshake) {
  Set-Content -LiteralPath ($Handshake + '.tmp') -Encoding ASCII -Value $PID
  Move-Item -LiteralPath ($Handshake + '.tmp') -Destination ($Handshake + '.ready')
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath ($Handshake + '.go'))) {
    if ((Test-Path -LiteralPath ($Handshake + '.cancel')) -or (Get-Date) -gt $deadline) { Say 'handoff cancelled'; exit 5 }
    Start-Sleep -Milliseconds 50
  }
  if (Test-Path -LiteralPath ($Handshake + '.cancel')) { Say 'handoff cancelled'; exit 5 }
}
if ($WaitPid -gt 0) { try { Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction SilentlyContinue } catch {} }
if ($WaitPid -gt 0 -and (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { Say 'app still running, abort'; exit 6 }
if (Test-Path -LiteralPath $Old) {
  try { Remove-Item -LiteralPath $Old -Recurse -Force } catch { $Old = $Dir + '.old-' + (Get-Date -Format yyyyMMddHHmmss) }
}
$moved = $false
for ($i = 0; $i -lt $Tries; $i++) {
  try { Rename-Item -LiteralPath $Dir -NewName (Split-Path -Leaf $Old); $moved = $true; break } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $moved) { Say 'install dir still locked, keep old version'; Start-App; exit 3 }
try {
  Rename-Item -LiteralPath $New -NewName $Leaf
} catch {
  Say ('moving .new failed, rolling back: ' + $_)
  try { Rename-Item -LiteralPath $Old -NewName $Leaf } catch { Say ('ROLLBACK FAILED: ' + $_) }
  Start-App
  exit 4
}
Say 'swapped'
if ($Version) {
  $needle = ($Dir + '\\Uninstall ').ToLowerInvariant()
  foreach ($root in @('HKCU:', 'HKLM:')) {
    try {
      Get-ChildItem -LiteralPath ($root + '\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall') -ErrorAction SilentlyContinue | ForEach-Object {
        $u = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).UninstallString
        if ($u -and $u.ToLowerInvariant().Contains($needle)) {
          try { Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value $Version; Say ('DisplayVersion ' + $root + ' -> ' + $Version) } catch {}
        }
      }
    } catch {}
  }
}
Start-App
exit 0
`;

/** PowerShell 单引号字符串：里面的单引号写两遍，别的字符（含中文、空格、$）原样 */
const 单引号 = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * UTF-16LE 编码命令，保留中文与单引号路径。生产调用编码短引导命令，读取本次生成的 ASCII 脚本，
 * 避免完整脚本的 base64 撑过 cmd 的命令行上限；直接调用 PowerShell 的脚本测试可内联全文。
 */
function 编码命令({ 目录, 等PID = 0, 重启 = false, 版本 = "", exe名 = "", 日志, 尝试次数 = 60, 交接 = "", 脚本 = "" }) {
  const 命令 = [
    脚本 ? `& ([scriptblock]::Create([IO.File]::ReadAllText(${单引号(脚本)})))` : `& {\n${换目录脚本}\n}`,
    "-Dir", 单引号(目录),
    "-WaitPid", String(Number(等PID) || 0),
    "-Relaunch", 重启 ? "1" : "0",
    "-Version", 单引号(版本 || ""),
    "-Exe", 单引号(exe名 || ""),
    "-Log", 单引号(日志 || ""),
    "-Handshake", 单引号(交接),
    "-Tries", String(Number(尝试次数) || 60),
  ].join(" ");
  return Buffer.from(命令, "utf16le").toString("base64");
}

/**
 * 同一个版本换目录失败的次数，记在 更新目录/swap-attempts.json：{ 版本, 次数 }。
 * 每次交给 PowerShell 之前 +1；下次启动时发现自己已经是那个版本了，就是换成了，清掉。
 * 连着两次没换成（组策略把 PowerShell 整个禁了、杀毒把脚本拦了……）就别再差量了——
 * 再下一遍只会再失败一遍。那时走整包安装程序，它不靠 PowerShell。
 */
const 尝试文件 = (更新目录) => path.join(更新目录, "swap-attempts.json");
function 读尝试(更新目录) {
  try {
    const j = JSON.parse(fs.readFileSync(尝试文件(更新目录), "utf8"));
    return j && typeof j.版本 === "string" && Number.isFinite(j.次数) ? j : null;
  } catch {
    return null;
  }
}
function 记换目录尝试(更新目录, 版本) {
  const 旧 = 读尝试(更新目录);
  const 次数 = 旧?.版本 === 版本 ? 旧.次数 + 1 : 1;
  try {
    fs.mkdirSync(更新目录, { recursive: true });
    fs.writeFileSync(尝试文件(更新目录), JSON.stringify({ 版本, 次数 }));
  } catch { /* 记不下来只是少一道保险 */ }
  return 次数;
}
/** 启动时调：已经是记着的那个版本了，说明换成了，清掉记录 */
function 换目录已生效(更新目录, 当前版本) {
  if (读尝试(更新目录)?.版本 === 当前版本) try { fs.rmSync(尝试文件(更新目录), { force: true }); } catch { /* 无妨 */ }
}
/** 这个版本已经换失败 上限 次了吗（当前还不是它） */
function 换目录屡败(更新目录, 版本, 上限 = 2) {
  const j = 读尝试(更新目录);
  return Boolean(j && j.版本 === 版本 && j.次数 >= 上限);
}

/**
 * 等 PowerShell 写就绪信号、cmd 中转退出后才授权更新并返回。调用方必须 await 后再退出；
 * before-quit 要先 preventDefault。只有 cmd pid 不能证明交接完成，Electron 太早退出会丢失更新。
 */
async function 启动换目录({ 目录, 等PID = 0, 重启 = false, 版本 = "", exe名 = "", 更新目录, 启动 = spawn, 就绪超时 = 20_000 }) {
  if (!目录 || !更新目录) throw new Error("换目录缺参数");
  fs.mkdirSync(更新目录, { recursive: true });
  const 日志 = path.join(更新目录, "update-swap.log");
  if (版本) 记换目录尝试(更新目录, 版本);
  // 每次独立交接文件，历史日志或迟到的上一次进程不能误触发本次更新。
  const 会话 = fs.mkdtempSync(path.join(更新目录, "swap-"));
  const 交接 = path.join(会话, "handoff");
  const 脚本 = path.join(会话, "swap.ps1");
  fs.writeFileSync(脚本, 换目录脚本, "ascii");
  // cmd 命令行比 CreateProcess 短：只编码引导命令，完整脚本在本机读取。
  const 参数 = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", 编码命令({ 目录, 等PID, 重启, 版本, exe名, 日志, 交接, 脚本 })];
  /*
    PowerShell 自己的输出（解析错误、被策略拦下、起都起不来）写到 update-swap.out.log。
    原来是 ignore：脚本连第一行 begin 都没写出来时，什么线索都没有（2026-09-29 CI 上就是这样）
  */
  const 输出文件 = path.join(更新目录, "update-swap.out.log");
  const 记 = (行) => { try { fs.appendFileSync(输出文件, `${new Date().toISOString()} [壳] ${行}\n`); } catch { /* 记不下就算了 */ } };
  let 输出 = "ignore";
  try {
    输出 = fs.openSync(输出文件, "a");
  } catch { /* 打不开就不记，不能因为日志挡住换目录 */ }
  /*
    两条都是 CI 上一次次栽出来的（2026-09-29）：
    1. **不要 detached**。Node 在 Windows 上把它实现成 DETACHED_PROCESS：没有控制台，Windows PowerShell 5.1
       一声不吭立刻退出。只要 windowsHide（隐藏的控制台）。
    2. **不挂在 Electron 的进程树上**。经 cmd /c start "" /b 转一手：cmd 起完 PowerShell 就退（几十毫秒），
       PowerShell 的父进程随即不存在，谁按进程树杀 Electron（任务管理器「结束进程树」、Playwright 收尾的
       taskkill /T /F）都杀不到它——它得活过 Electron 的退出，才能在那之后换目录。
       直接从 node 起能换（真 Windows 用例里过了），从 Electron 退出时起就被连树带走，日志一行都没有。
    参数原样拼（windowsVerbatimArguments）：start 的空标题 "" 经 node 的转义会变成 \"\"，cmd 认不了；
    其余参数都没有空格（base64 也没有），拼起来不会断
  */
  const 命令 = ["/d", "/c", "start", '""', "/b", "powershell.exe", ...参数];
  let child;
  try {
    child = 启动("cmd.exe", 命令, { stdio: ["ignore", 输出, 输出], windowsHide: true, windowsVerbatimArguments: true });
    记(`经 cmd 启动 powershell.exe（cmd pid=${child.pid ?? "无"}）版本=${版本 || "-"} 目录=${目录}`);
    await new Promise((resolve, reject) => {
      let 中转已退出 = false;
      const 起不来 = (e) => { clearInterval(timer); clearTimeout(timeout); reject(e); };
      const timer = setInterval(() => {
        if (!中转已退出 || !fs.existsSync(`${交接}.ready`)) return;
        try {
          const pid = Number(fs.readFileSync(`${交接}.ready`, "utf8").replace(/^\uFEFF/, "").trim());
          if (!Number.isInteger(pid) || pid <= 0 || !进程活着(pid)) throw new Error("更新辅助程序在交接前退出");
          // 先记录辅助进程，再放行换目录：用户此时再次点开旧 exe，启动保护才能认出差量安装。
          // 旧进程只显示短暂提示就退出；持续运行会锁住 Windows 的安装目录，反而无法换包。
          if (!记安装中(更新目录, { 版本, pid, 方式: "差量" })) throw new Error("无法记录差量安装状态，已取消换包");
          fs.writeFileSync(`${交接}.go`, "go");
          clearInterval(timer); clearTimeout(timeout);
          resolve();
        } catch (e) { 起不来(e); }
      }, 25);
      const timeout = setTimeout(() => 起不来(new Error("更新辅助程序启动超时，已取消本次更新，请重试")), 就绪超时);
      child.once("error", 起不来);
      child.once("exit", (code) => {
        if (code !== 0) 起不来(new Error(`更新中转进程退出（${code}），请重试`));
        else 中转已退出 = true;
      });
    });
    记("PowerShell 已就绪，中转进程已退出，允许应用退出");
    child.unref();
    return { 参数 };
  } catch (e) {
    // 迟到的辅助进程也必须取消，不能在用户稍后退出时意外安装。
    清掉安装记录(更新目录);
    fs.writeFileSync(`${交接}.cancel`, "cancel");
    记(`交接失败：${e?.message ?? e}`);
    throw e;
  } finally {
    if (typeof 输出 === "number") try { fs.closeSync(输出); } catch { /* 子进程持有自己的句柄 */ }
  }
}

module.exports = { 启动安装, 记安装中, 清掉安装记录, 进程活着, 安装进行中, 安装目录, 可写, 能差量更新, 补齐安装器文件, 换目录脚本, 编码命令, 启动换目录, 记换目录尝试, 换目录已生效, 换目录屡败 };
