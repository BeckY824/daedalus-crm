/**
 * 这台电脑是哪一台。
 *
 * 只为一件事存在：**AI 免费次数里那 30 次「注册赠送」要一台机器只发一次**。
 * 在这之前次数只按账号算，而账号是网页上自助注册的——同一台电脑上再注册一个号
 * 就是再送 30 次（用户 2026-09-19 拍板要堵掉）。云端那边的账本见
 * src/lib/tenant/credits.ts，记账的表是控制面的 MachineSignup。
 *
 * 认机器用**硬件 UUID**：
 *   macOS   IOPlatformUUID（ioreg）      —— 主板上的，重装系统不变
 *   Windows MachineGuid（注册表）        —— 装系统时生成，重装才变
 *   Linux   /etc/machine-id             —— 同上
 *
 * **传上去的是加盐 sha256，不是 UUID 本身。** 云端只存那 64 位十六进制，
 * 拿到我们的库也还原不出任何硬件标识符。盐就写在下面这个常量里，
 * 它**不是秘密**（代码是 AGPL 的，谁都看得见），也不需要是：它防的是
 * 「拿一张现成的硬件 UUID 表来撞我们的哈希」，不是防我们自己。
 *
 * ---
 *
 * **取不到硬件 UUID 时返回 null，绝不编一个。**
 *
 * 想过的三种「降级」，一个都不行：
 *   - 每次启动随机一个 → 每次都是一台新电脑，等于把这道闸门反过来用，白送到底；
 *   - 生成一个 id 存在本地文件里 → 删掉文件就换一份额度，和"清 cookie"一个级别，
 *     而且要等有人发现才知道漏了；
 *   - 拿机器名 / 用户名的哈希顶上 → 改个机器名就是新电脑，同时全世界所有叫
 *     MacBook-Pro 的机器撞成同一台，把一堆毫不相干的人互相挡住。
 *
 * 所以宁可诚实地返回 null。服务端对「不知道是哪台机器」的处理是**不发注册赠送、
 * 每日赠送照发**——那个人还能用 AI（一天 3 次），只是没有开局那 30 次，
 * 需要的话运营台还能手工补。反过来（不知道就照发）才是真的坏：
 * 那样只要把请求里的机器字段删掉，这整件事就等于没做。
 *
 * 纯 Node，不 require electron：壳、单测都直接用得上。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

/**
 * 加盐用的常量。**不是秘密**（见上）。
 * 带上版本号是为了留一条后路：万一以后换认机器的口径，换个版本号就是一套新哈希，
 * 不会和旧的混在一张表里。改它等于「所有机器都变成新机器」，除了重定口径别动。
 */
const 盐 = process.env.CRM_MACHINE_SALT || "daedalus-crm/machine/v1";

/**
 * 明显是占位、不该当成一台机器的值。
 *
 * 一批用同一个装机镜像克隆出来的机器会共用它们。把这种值当成一台真机器最糟：
 * 第一个人领走那 30 次，后面**所有**用同款镜像的人都被判成「这台电脑领过了」——
 * 那是一群毫不相干的人。当成取不到，至少只影响他们自己那一份开局额度。
 */
const 占位值 = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009", // 某些虚拟机/主板固件出厂就是这一串
  "0",
  "none",
  "unknown",
  "default",
  "to be filled by o.e.m.",
]);

/** 跑一条命令拿标准输出。取不到就空字符串——这个模块里任何一步失败都只是"取不到" */
function 跑(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 4000,
      // stderr 丢掉：取不到是正常分支，不该往崩溃日志里灌东西
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return "";
  }
}

/**
 * 规整成一个能比较的字符串。不像个硬件标识符的一律当没取到。
 *
 * 长度下限 8：短得离谱的值（"0"、"N/A"）不是标识符，而当成标识符就会把
 * 一堆机器撞到一起。上限截到 128，防一个坏掉的命令把整篇输出灌进来。
 */
function 规整(原始) {
  const s = String(原始 ?? "")
    .trim()
    .replace(/^[{[]|[}\]]$/g, "")
    .toLowerCase();
  if (s.length < 8 || s.length > 128) return null;
  if (占位值.has(s)) return null;
  // 十六进制、连字符、冒号之外的东西出现了，说明拿到的不是标识符（多半是一段报错）
  if (!/^[0-9a-f][0-9a-f:-]*$/.test(s)) return null;
  // 全是 0 / f 的变体也当占位
  if (/^[-:0]+$/.test(s) || /^[-:f]+$/.test(s)) return null;
  return s;
}

/** macOS：主板上的那个 UUID */
function 苹果的() {
  const out = 跑("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? "";
}

/**
 * Windows：注册表 HKLM\SOFTWARE\Microsoft\Cryptography 下的 MachineGuid。
 *
 * 64 位系统上 32 位进程读 HKLM\SOFTWARE 会被重定向到 WOW6432Node（那儿没有这个键），
 * 所以第一遍空了再显式要一次 64 位视图。我们出的包是 x64，但别让这件事取决于打包配置。
 */
function 微软的() {
  const 键 = ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"];
  for (const args of [键, [...键, "/reg:64"]]) {
    const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(跑("reg", args));
    if (m) return m[1];
  }
  return "";
}

/** Linux：systemd 的 machine-id（dbus 那份是同一个值的老位置） */
function 企鹅的() {
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const s = fs.readFileSync(f, "utf8").trim();
      if (s) return s;
    } catch {
      /* 换下一个 */
    }
  }
  return "";
}

/** 这台机器的硬件标识符原文。**只在本机用，绝不往外发**——外发的是它的哈希 */
function 硬件标识() {
  if (process.platform === "darwin") return 苹果的();
  if (process.platform === "win32") return 微软的();
  if (process.platform === "linux") return 企鹅的();
  return "";
}

/** 原文 → 加盐 sha256。规整不过就是 null（调用方据此当"取不到"） */
function 算哈希(原始) {
  const s = 规整(原始);
  return s ? crypto.createHash("sha256").update(`${盐}:${s}`).digest("hex") : null;
}

/** undefined = 还没算过；null = 算过、这台机器取不到 */
let 缓存;

/**
 * 这台机器的哈希，取不到返回 null。
 *
 * 缓存一次：算一次要 fork 一个 ioreg / reg，而这个值在进程活着的这段时间里不会变。
 */
function 机器哈希() {
  if (缓存 === undefined) 缓存 = 算哈希(硬件标识());
  return 缓存;
}

module.exports = { 机器哈希, 硬件标识, 算哈希, 规整, 盐 };
