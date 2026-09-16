/**
 * 差量更新：只下变了的文件，不下整包。
 *
 * 思路（2026-09-16 定，数据见 ~/CRM/桌面端差量更新方案-2026-09-16.md）：
 * 不比 dmg，比解开的 .app，**以已装的那份为基准**。发版时多出一个 ditto 打的 zip 和一份清单
 * （scripts/make-manifest.mjs：每个文件的路径、sha256、权限、压缩数据在 zip 里的偏移）。
 * 这里拿清单和已装的包比：没变的硬链接过来（同一卷，零耗时零空间），变了的对 zip 发
 * HTTP Range 只取那几段、用 node 自带的 zlib 解压、边写边验哈希，组装成 X.app.new。
 * 换包和整包路径共用 install.js 的那一段。
 *
 * 为什么不是 electron-updater 的 blockmap：它在 macOS 上不支持。为什么不是发版时生成补丁
 * （Sparkle / electron-delta 的做法）：那要 N 个旧版本 N 个补丁，我们两天打 12 个 tag。
 * 一份清单服务所有旧版本，比对在客户端做。
 *
 * 实测：同代码重打包 393 MB 一字不差、只下 2.3 MB；跨 10 个小版本约 5 MB；
 * GitHub Release 资产支持 Range，连接复用后每请求约 40 ms。整包 161 MB 要 14 分钟。
 *
 * 硬约束：
 *   - 运行中的 .app 一个字节不碰，全部在 .new 里做
 *   - 幂等：.new 里已验过哈希的文件跳过——中断再跑就是断点续传
 *   - 任何一步不对就抛 退回整包，上层走今天的 dmg 路径；首次安装一行不改
 *
 * 不引 electron，全是 node 内置模块；fetch 和执行外部命令的函数可注入，能直接拿 node 测。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { 删目录 } = require("./install");

/** 抛这个表示「别用差量了，走整包」——不是坏了，是这次不划算或对不上 */
class 退回整包 extends Error {
  constructor(原因) {
    super(原因);
    this.name = "退回整包";
  }
}

function 默认运行(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} 失败：${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function 文件哈希(p) {
  const h = crypto.createHash("sha256");
  for await (const c of fs.createReadStream(p)) h.update(c);
  return h.digest("hex");
}

/* ---------- 清单 ---------- */

async function 拉清单({ url, fetch: f = globalThis.fetch }) {
  const res = await f(url, { headers: { "User-Agent": "DaedalusCRM-Desktop" } });
  if (!res.ok) throw new Error(`拉清单失败：HTTP ${res.status}`);
  const 字节 = Buffer.from(await res.arrayBuffer());
  let m;
  try {
    m = JSON.parse(zlib.gunzipSync(字节).toString("utf8"));
  } catch (e) {
    throw new Error(`清单解不开：${e.message}`);
  }
  if (m?.v !== 1 || !Array.isArray(m.entries) || !m.bundle || !m.zip?.size) throw new Error("清单格式不认识");
  return m;
}

/* ---------- 本地状态 ---------- */

/**
 * 已装的包里现在有什么。**扫整个包**，不是只看清单里的路径：改了名的文件（Turbopack 的
 * chunk 每次构建都换名）旧路径不在新清单里，只按清单路径找永远找不到它——第一版就是这么写的，
 * 测试立刻抓到了。哈希 400 MB 在 Apple 芯片上 1–2 秒，按 (size, mtime) 缓存到一个 JSON，之后秒级。
 * 返回：
 *   按路径: Map<相对路径, sha256>
 *   按哈希: Map<sha256, 本地绝对路径>  —— 内容没变只是改了名的，从这里找
 */
/**
 * Electron 给 Node 的 fs 打了 asar 补丁：`app.asar` 会被当成目录，对它本身开读流报 ENOENT、stat 说大小 0。
 * 0.24.1→0.24.2 真机首验就栽在这：遍历走到 Resources 的第一个条目 app.asar 就抛，只算到 264 个文件，
 * 剩下 2106 个全被当成「本地没有」重下了 58.5 MB。差量这套只碰真实文件，做事期间把补丁关掉；完了恢复。
 * 纯 Node（测试、脚本）里 process.noAsar 没有意义，设了也无害。
 */
async function 不管asar(fn) {
  const 原 = process.noAsar;
  process.noAsar = true;
  try {
    return await fn();
  } finally {
    process.noAsar = 原;
  }
}

async function 本地状态(bundle, { 缓存路径 = null } = {}) {
  return 不管asar(() => 本地状态_(bundle, { 缓存路径 }));
}

async function 本地状态_(bundle, { 缓存路径 = null } = {}) {
  let 缓存 = {};
  if (缓存路径) {
    try {
      缓存 = JSON.parse(await fsp.readFile(缓存路径, "utf8"));
    } catch {
      /* 没有缓存就全算 */
    }
  }
  const 按路径 = new Map();
  const 按哈希 = new Map();
  const 新缓存 = {};
  async function 走(dir) {
    for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await 走(p);
      else if (d.isFile()) {
        const rel = path.relative(bundle, p);
        const st = await fsp.lstat(p);
        const 键 = `${st.size}:${st.mtimeMs}`;
        let h = 缓存[rel]?.k === 键 ? 缓存[rel].h : null;
        if (!h) h = await 文件哈希(p);
        新缓存[rel] = { k: 键, h };
        按路径.set(rel, h);
        if (!按哈希.has(h)) 按哈希.set(h, p);
      }
      // 符号链接不哈希：清单里的链接按 target 直接建
    }
  }
  // 已装的包不在（路径错了、被人删了）：本地什么都没有，全部要下——安全阀会把它判成整包。
  // 只兜「包本身不在」这一种；遍历中间的错误要抛出去，不然算了一半就当成算完了（0.24.2 那次就是这样）
  let 包在 = true;
  try {
    await fsp.access(bundle);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    包在 = false;
  }
  if (包在) await 走(bundle);
  if (缓存路径) {
    await fsp.mkdir(path.dirname(缓存路径), { recursive: true });
    await fsp.writeFile(缓存路径, JSON.stringify(新缓存));
  }
  return { 按路径, 按哈希 };
}

/* ---------- 比对 ---------- */

/**
 * 清单里的每个文件：本地同路径同哈希 → 复用；本地别处有同哈希 → 也复用（改名而已）；
 * 都没有 → 下载。符号链接不下载，按清单直接建。
 */
function 比对(entries, { 按路径, 按哈希 }) {
  const 复用 = [];
  const 下载 = [];
  const 链接 = [];
  for (const e of entries) {
    if (e.t === "l") {
      链接.push(e);
      continue;
    }
    const 本地 = 按路径.get(e.p);
    if (本地 === e.h) 复用.push({ e, from: null }); // from=null：同路径
    else if (按哈希.has(e.h)) 复用.push({ e, from: 按哈希.get(e.h) });
    else 下载.push(e);
  }
  return { 复用, 下载, 链接 };
}

/* ---------- Range 规划 ---------- */

/**
 * 要下的条目在 zip 里往往挨着（同一目录的文件是连着写的）。两个条目之间的空隙小于 间隔 就
 * 并成一个 Range——多下几十 KB 没用的字节，换少一次往返（冷连接 1–2 秒，复用后 40 ms）。
 * 返回按起点排序的段，每段带它覆盖的条目。
 */
function 规划Range(下载, { 间隔 = 64 * 1024 } = {}) {
  const 排好 = [...下载].sort((a, b) => a.off - b.off);
  const 段 = [];
  for (const e of 排好) {
    const 尾 = 段[段.length - 1];
    if (尾 && e.off - 尾.end <= 间隔) {
      尾.end = Math.max(尾.end, e.off + e.cs);
      尾.entries.push(e);
    } else {
      段.push({ start: e.off, end: e.off + e.cs, entries: [e] });
    }
  }
  return 段;
}

/* ---------- 网络 ---------- */

/**
 * GitHub 的资产地址是 302 到一个带签名的直链，签名约 1 小时有效。解析一次，之后所有 Range
 * 都打直链（少一次跳转，也不会每次都被 GitHub 的 API 限流）；403/410 表示过期，重解析。
 */
async function 解析直链({ url, fetch: f = globalThis.fetch }) {
  const res = await f(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": "DaedalusCRM-Desktop" } });
  if (!res.ok) throw new Error(`解析下载地址失败：HTTP ${res.status}`);
  return res.url || url;
}

async function 取Range({ url, start, end, fetch: f = globalThis.fetch }) {
  // HTTP Range 的 end 是闭区间
  const res = await f(url, { headers: { Range: `bytes=${start}-${end - 1}`, "User-Agent": "DaedalusCRM-Desktop" } });
  if (res.status === 403 || res.status === 410) {
    const e = new Error("下载地址过期");
    e.过期 = true;
    throw e;
  }
  // 200 表示服务器不理 Range、准备给整个文件——绝不能默默收下 160 MB
  if (res.status !== 206) throw new Error(`Range 请求没有得到 206（得到 ${res.status}），这个源不支持差量`);
  const 字节 = Buffer.from(await res.arrayBuffer());
  if (字节.length !== end - start) throw new Error(`Range 返回 ${字节.length} 字节，要的是 ${end - start}`);
  return 字节;
}

async function 并发(items, n, fn) {
  let i = 0;
  const 跑 = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, 跑));
}

/* ---------- 组装 ---------- */

async function 写文件(dest, data, mode) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, data, { mode });
  await fsp.chmod(dest, mode);
}

/** .new 里这个路径已经是清单要的内容了吗——断点续传就靠它 */
async function 已就绪(dest, e) {
  try {
    const st = await fsp.lstat(dest);
    if (!st.isFile() || st.size !== e.s) return false;
    return (await 文件哈希(dest)) === e.h;
  } catch {
    return false;
  }
}

/**
 * 把清单描述的包组装到 目标 目录（调用方传 X.app.new）。
 * 进度回调收 (已下字节, 要下总字节)。返回统计。
 */
async function 组装({ 清单, 已装, 目标, zipUrl, 比对结果, fetch: f = globalThis.fetch, 并发数 = 4, 进度 = () => {}, 日志 = () => {} }) {
  const { 复用, 下载, 链接 } = 比对结果;
  await fsp.mkdir(目标, { recursive: true });

  // 1) 没变的：硬链接。硬链接共享 inode 也共享权限，所以清单要的权限和本地不一样时改成拷贝，
  //    不然 chmod 会改到已装的那份
  let 链过 = 0;
  for (const { e, from } of 复用) {
    const dest = path.join(目标, e.p);
    if (await 已就绪(dest, e)) continue;
    const src = from ?? path.join(已装, e.p);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rm(dest, { force: true });
    const st = await fsp.lstat(src);
    if ((st.mode & 0o7777) === e.m) {
      try {
        await fsp.link(src, dest);
        链过++;
        continue;
      } catch {
        /* 跨卷或不允许，退到拷贝 */
      }
    }
    await fsp.copyFile(src, dest);
    await fsp.chmod(dest, e.m);
  }

  // 2) 符号链接
  for (const e of 链接) {
    const dest = path.join(目标, e.p);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rm(dest, { force: true });
    await fsp.symlink(e.target, dest);
  }

  // 3) 要下的：先排掉 .new 里已经好了的（续传），再按 Range 段取
  const 还要下 = [];
  for (const e of 下载) if (!(await 已就绪(path.join(目标, e.p), e))) 还要下.push(e);
  const 总 = 还要下.reduce((a, e) => a + e.cs, 0);
  let 已 = 0;
  进度(0, 总);
  const 段 = 规划Range(还要下);
  日志(`复用 ${复用.length}（硬链接 ${链过}），下载 ${还要下.length} 个文件，${段.length} 个 Range，${(总 / 1048576).toFixed(1)} MB`);

  let 直链 = await 解析直链({ url: zipUrl, fetch: f });
  await 并发(段, 并发数, async (s) => {
    let buf;
    try {
      buf = await 取Range({ url: 直链, start: s.start, end: s.end, fetch: f });
    } catch (e) {
      if (!e.过期) throw e;
      直链 = await 解析直链({ url: zipUrl, fetch: f });
      buf = await 取Range({ url: 直链, start: s.start, end: s.end, fetch: f });
    }
    for (const e of s.entries) {
      const raw = buf.subarray(e.off - s.start, e.off - s.start + e.cs);
      const data = e.method === 8 ? zlib.inflateRawSync(raw) : raw;
      if (data.length !== e.s || sha256(data) !== e.h) throw new Error(`${e.p}：下下来的内容和清单对不上`);
      await 写文件(path.join(目标, e.p), data, e.m);
    }
    已 += s.end - s.start;
    进度(已, 总);
  });

  return { 复用: 复用.length, 硬链接: 链过, 下载: 还要下.length, 段: 段.length, 字节: 总 };
}

/* ---------- 入口 ---------- */

/**
 * 第一步——差量估算：清单 → 比对，算出要下多少。**不下 zip、不动磁盘**，只拉 100 多 KB 的清单，
 * 所以可以在问用户之前先做，侧栏按钮上才写得出「差量 2.3 MB」。
 * 不划算或对不上的情况抛 退回整包，上层按钮就写整包的体积。
 */
async function 差量估算({ 清单Url, 已装, 缓存路径 = null, 最大占比 = 0.6, fetch: f = globalThis.fetch, 日志 = () => {} }) {
  const 清单 = await 拉清单({ url: 清单Url, fetch: f });
  if (清单.bundle !== path.basename(已装)) throw new 退回整包(`清单里的包名 ${清单.bundle} 和已装的 ${path.basename(已装)} 对不上`);

  日志("比对已装的文件");
  const 本地 = await 本地状态(已装, { 缓存路径 });
  const 比对结果 = 比对(清单.entries, 本地);
  const 要下 = 比对结果.下载.reduce((a, e) => a + e.cs, 0);
  // 变得太多就不差量了：整包那条路更简单，也是首次安装在走的路
  if (要下 > 最大占比 * 清单.zip.size) throw new 退回整包(`要下 ${(要下 / 1048576).toFixed(0)} MB，超过整包的 ${最大占比 * 100}%，不如整包`);
  return { 清单, 比对结果, 要下 };
}

/**
 * 第二步——差量组装：按估算的结果组装到 已装.new → 验签。用户点了按钮才走到这。
 * 成功返回 .new 的路径和统计，由调用方换包（install.js 的那一段）并重启。
 */
async function 差量组装(opts) {
  return 不管asar(() => 差量组装_(opts));
}

async function 差量组装_({ 清单, 比对结果, zipUrl, 已装, fetch: f = globalThis.fetch, 运行 = 默认运行, 进度 = () => {}, 日志 = () => {} }) {
  const 目标 = `${已装}.new`;
  const 统计 = await 组装({ 清单, 已装, 目标, zipUrl, 比对结果, fetch: f, 进度, 日志 });

  // 组装出来的包必须能过签名校验。过不了先 ad-hoc 重签一次——我们本来就没有 Developer ID，
  // CI 的 sign.js 做的就是这个，客户端做一样的事。再过不了才放弃
  日志("校验签名");
  try {
    await 运行("codesign", ["--verify", "--strict", "--deep", 目标]);
  } catch {
    日志("签名校验没过，ad-hoc 重签");
    await 运行("codesign", ["--force", "--deep", "--sign", "-", 目标]);
    try {
      await 运行("codesign", ["--verify", "--strict", "--deep", 目标]);
    } catch (e) {
      await 删目录(目标, 运行).catch(() => {});
      throw new 退回整包(`组装出来的包签名校验不过：${e.message}`);
    }
  }
  return { 目标, 统计 };
}

/** 两步连着做（测试和脚本用）。应用里是分开的：先估算给按钮看，点了再组装 */
async function 差量安装(opts) {
  const 估 = await 差量估算(opts);
  return 差量组装({ ...opts, ...估 });
}

module.exports = { 退回整包, 不管asar, 拉清单, 本地状态, 比对, 规划Range, 解析直链, 取Range, 组装, 差量估算, 差量组装, 差量安装 };
