/**
 * 一个云端账号一份数据。
 *
 * **0.39.2 之前只有一份。** 数据在 `<数据根>/data/crm.db`，而那个路径跟着
 * **macOS 账号**走，不跟云端账号走。于是同一个 macOS 登录下，A 在应用里退出、
 * B 登录，B 打开的是同一个库——A 的客户、跟进、AI 对话全看得见。
 * 用户 2026-09-19 报上来的就是这个。
 *
 * 现在按账号分开：
 *
 *   <数据根>/
 *     current.json          现在是谁（只存 key，别的什么都不存）
 *     accounts/<key>/       一个账号一份：crm.db、.cloud.json、.auth-secret、.init-password
 *     data/                 **升级前那一份**，由 迁移旧数据() 认领进 accounts/
 *
 * **拦不住的那一层，说在前面**：两个人共用同一个 macOS 登录，就共用同一套文件权限。
 * 分目录挡住的是「在应用里看见」，挡不住「拿 SQLite 工具直接开对方的库文件」。
 * 真要彻底隔开只有一条路——各用各的 macOS 账号，那时连数据根都是两份。
 * 界面上要如实这么写，别让人以为分了目录就等于加了锁。
 *
 * key 用账号 id 的哈希，不用 id 原文，也不用手机号/邮箱：
 *   - 目录名会出现在日志、崩溃报告、「打开数据文件夹」的窗口标题里，
 *     那些地方不该躺着一个手机号；
 *   - 哈希是定长的十六进制，天然不含路径分隔符和大小写敏感问题
 *     （macOS 的文件系统默认大小写不敏感，拿邮箱当目录名迟早撞上）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** 还没有任何账号登录过时，数据先放这儿；第一次登录成功就把它改名认领走 */
const 未认领 = "_未认领";

/**
 * 账号 id → 目录名。
 * 截断到 24 位十六进制：够避开碰撞，又不至于让路径长得没法看。
 */
function key(accountId) {
  const s = String(accountId ?? "").trim();
  if (!s) return null;
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
}

/**
 * 目录里的归属标记，内容就是账号 id。
 *
 * **不能拿 .cloud.json 当归属凭据**：那是令牌，退出登录时会被删掉。
 * 甲退出、乙在同一个目录上登录，那一刻 .cloud.json 不存在，就看不出「换人了」——
 * 于是乙的名字和邮箱会被写进甲的 User 表。所以归属另记一份，退出不动它。
 */
const 归属文件 = "\u002eowner";

const 账号根 = (数据根) => path.join(数据根, "accounts");
const 账号目录 = (数据根, k) => path.join(账号根(数据根), k);
const 指针文件 = (数据根) => path.join(数据根, "current.json");

/** 现在挂在哪个 key 上。没有就是 null */
function 读指针(数据根) {
  try {
    const c = JSON.parse(fs.readFileSync(指针文件(数据根), "utf8"));
    return typeof c.key === "string" && c.key ? c.key : null;
  } catch {
    return null;
  }
}

/** 这个目录归谁。没有标记（未认领、升级上来的）就是 null */
function 归谁(目录) {
  try {
    const v = fs.readFileSync(path.join(目录, 归属文件), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function 记归属(目录, accountId) {
  try {
    fs.mkdirSync(目录, { recursive: true });
    fs.writeFileSync(path.join(目录, 归属文件), String(accountId), { mode: 0o600 });
  } catch {
    /* 记不上不致命：下一次认领还会再记一遍 */
  }
}

function 写指针(数据根, k) {
  fs.mkdirSync(数据根, { recursive: true });
  fs.writeFileSync(指针文件(数据根), JSON.stringify({ key: k }, null, 2), { mode: 0o600 });
}

/**
 * 升级：把老的单份 `data/` 认领进 accounts/。
 *
 * **这是整个改动里唯一会碰到用户既有数据的一步，只做改名，不做复制也不做删除**——
 * 复制会在磁盘紧张时半路失败并留下两份说不清谁新的库，删除更不必说。
 * 改名是原子的，失败就什么都没动。
 *
 * 归谁：`data/.cloud.json` 里那个账号。它是升级前最后一个登录的人，
 * 那份数据本来就是他在用。读不出账号（从没登录过、文件坏了）就先放进
 * `_未认领`，等下一次登录成功再认领——**绝不丢**，也绝不猜一个账号塞给它。
 *
 * 幂等：`data/` 不在了就什么都不做。每次启动都会调。
 */
function 迁移旧数据(数据根, 取账号id) {
  const 旧 = path.join(数据根, "data");
  if (!fs.existsSync(旧)) return null;
  // 已经有同名目标了（上一次迁到一半？手工动过？）：不覆盖，把旧的留在原地让人来看
  const id = 取账号id(path.join(旧, ".cloud.json"));
  const k = key(id) ?? 未认领;
  const 目标 = 账号目录(数据根, k);
  if (fs.existsSync(目标)) return null;
  fs.mkdirSync(账号根(数据根), { recursive: true });
  fs.renameSync(旧, 目标);
  if (k !== 未认领) 写指针(数据根, k);
  return { key: k, 目录: 目标, 认领了: k !== 未认领 };
}

/**
 * 这次启动该用哪个目录。
 *
 * 指针指着谁就用谁——**常见情况是同一个人再打开一次应用，那时不该有任何动静**。
 * 指针没有（第一次装、或者刚退出登录）就落到 `_未认领`：
 * 登录页本身也要一个能跑的库（本地服务起来就要建表、自动登录本机账号），
 * 不给它目录的话应用根本开不到登录页。
 */
function 当前目录(数据根) {
  const k = 读指针(数据根) ?? 未认领;
  const d = 账号目录(数据根, k);
  fs.mkdirSync(d, { recursive: true });
  return { key: k, 目录: d };
}

/**
 * 登录成功之后：这份数据从此归他。返回**数据目录的路径变了没有**。
 *
 * 三种情况：
 *   1. 指针已经是他了 —— 什么都不做（同一个人重新打开应用、或重新登录一次）
 *   2. 现在挂在 `_未认领` 上 —— 改名认领：那份数据本来就是他刚建的
 *      （第一次装应用，或者升级时读不出账号的那一份）
 *   3. 挂在别人名下 —— 换到他自己那个目录
 *
 * 情况 2 里如果他自己的目录已经存在（以前登录过、退出了、现在又回来），
 * 那就不能拿 `_未认领` 那份去盖掉他原来的数据——留着 `_未认领`，走情况 3。
 *
 * ---
 *
 * **返回的是「路径变了没有」，不是「要不要重启」**，这两件事差一层。
 * 第一版写的是 `要重启`，而且情况 2 特地返回 false，理由是「改的是目录名，
 * 本地服务连着的 inode 没变」。那句话对了一半：已经打开的文件描述符确实还能用，
 * **但 `CRM_DATA_DIR` 是进程启动时就烤进子进程环境里的一个字符串**——
 * 目录一改名，那个字符串就指向一个不存在的路径，而服务端每次请求都要现读
 * `<CRM_DATA_DIR>/.cloud.json` 拿 AI 配置（lib/desktop/cloud.ts 的 读()）。
 * 于是表现是：数据还在、人却像是突然退了登录，AI 也没了。
 *
 * 所以改名和换目录一样危险，路径一变就得重起本地服务。要不要重启由调用方判断——
 * 启动时服务还没起来，那是唯一不用重启的时机，也正是升级认领该发生的地方。
 */
function 认领(数据根, accountId) {
  const k = key(accountId);
  if (!k) return { key: null, 换了目录: false };
  const 之前 = 账号目录(数据根, 读指针(数据根) ?? 未认领);
  const 现在 = 读指针(数据根);
  if (现在 === k) {
    const d = 账号目录(数据根, k);
    记归属(d, accountId);
    return { key: k, 目录: d, 换了目录: false };
  }

  const 他的 = 账号目录(数据根, k);
  const 未认领目录 = 账号目录(数据根, 未认领);
  if (现在 === null && fs.existsSync(未认领目录) && !fs.existsSync(他的)) {
    fs.renameSync(未认领目录, 他的);
    记归属(他的, accountId);
    写指针(数据根, k);
    return { key: k, 目录: 他的, 换了目录: 他的 !== 之前, 认领了未认领的: true };
  }

  fs.mkdirSync(他的, { recursive: true });
  记归属(他的, accountId);
  写指针(数据根, k);
  return { key: k, 目录: 他的, 换了目录: 他的 !== 之前 };
}

/**
 * 退出登录：指针清掉，**数据一个字节都不动**。
 *
 * 他下次再登录回来，认领() 会把指针指回他那份，东西还在。
 * 退出不等于删数据——那是两件事，要删有「打开数据文件夹」那条路，由人自己动手。
 */
function 退出(数据根) {
  try {
    fs.rmSync(指针文件(数据根), { force: true });
  } catch {
    /* 本来就没有 */
  }
}

module.exports = { key, 当前目录, 认领, 退出, 迁移旧数据, 读指针, 写指针, 归谁, 账号目录, 未认领, 归属文件 };
