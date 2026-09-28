const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { 校验sha256 } = require("./install");

// NSIS 负责等待旧实例退出、覆盖程序、保留数据并重新启动。
// 启动前再次验哈希，避免下载后安装文件被替换。路径不经 shell。
async function 启动安装({ 文件, sha256, 启动 = spawn }) {
  if (!/^[a-f0-9]{64}$/i.test(sha256 || "")) throw new Error("Windows 更新缺少 SHA-256 校验值");
  await 校验sha256(文件, sha256);
  await new Promise((resolve, reject) => {
    const child = 启动(文件, ["/S", "--updated", "--force-run"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
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

function 可写(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
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
if (-not (Test-Path -LiteralPath $New)) { Say 'no .new, nothing to do'; Start-App; exit 2 }
if ($WaitPid -gt 0) { try { Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction SilentlyContinue } catch {} }
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

/**
 * 把换目录交给 PowerShell，自己立刻返回（调用方接着退出）。**同步**：before-quit 里进程正在退，
 * 等不到异步回来；spawn 本身是同步建进程的，建好就 unref 撒手。
 * 脚本写到 更新目录 下（每次覆盖），日志也在那：出了问题看 update-swap.log。
 */
function 启动换目录({ 目录, 等PID = 0, 重启 = false, 版本 = "", exe名 = "", 更新目录, 启动 = spawn }) {
  if (!目录 || !更新目录) throw new Error("换目录缺参数");
  fs.mkdirSync(更新目录, { recursive: true });
  const 脚本 = path.join(更新目录, "swap-install-dir.ps1");
  fs.writeFileSync(脚本, 换目录脚本, "ascii");
  const 参数 = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", 脚本,
    "-Dir", 目录,
    "-WaitPid", String(等PID || 0),
    "-Relaunch", 重启 ? "1" : "0",
    "-Version", String(版本 || ""),
    "-Exe", String(exe名 || ""),
    "-Log", path.join(更新目录, "update-swap.log"),
  ];
  const child = 启动("powershell.exe", 参数, { detached: true, stdio: "ignore", windowsHide: true });
  child.on?.("error", () => {});
  child.unref?.();
  return { 脚本, 参数 };
}

module.exports = { 启动安装, 安装目录, 能差量更新, 补齐安装器文件, 换目录脚本, 启动换目录 };
