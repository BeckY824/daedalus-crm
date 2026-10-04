/**
 * 记住上次停在哪一页，重启后回到原地——包括更新之后的那次重启。
 *
 * 以前每次起来都落回 /dashboard：装个更新回来，刚看到一半的客户记录没了，得自己再翻。
 * 只记同一个站里的**应用路径**；登录、找回密码、API、后台这些不是"你工作的地方"，
 * 记了反而把人送回门口。首页也不记——它本来就是默认落点，记了等于没记。
 *
 * 纯函数、不引 electron：main.js 里的东西测不了，这一小段单独拎出来测。
 *
 * **按账号分开记**（D-025，2026-10-04）：本地模式下记在当前账号自己的数据目录里，
 * 和那份库放在一起——记的页（/customers/<id>）指向的本来就是那份库里的记录。
 * 原来记在数据根的 config.json，不分账号，又连 query 一起记：同一台电脑换乙登录，
 * 乙进门落到甲最后那一页，搜索框里是甲搜的字、问 AI 那栏里是甲问的话。
 * 服务器模式（连别人的站）仍记在 config.json：那边换账号是那个站自己的事。
 */
const fs = require("node:fs");
const path = require("node:path");

/** 账号数据目录里那个文件。点开头：「打开数据文件夹」时不扎眼 */
const 记录文件 = ".last-route.json";

const 不记的 = /^\/(login|signup|forgot|api|admin|_next)(\/|$)/;

/** 页面跳到了 url，要不要记下来。返回该记的路径（含 query），不该记就 null */
function 可恢复的路径(url, 根) {
  if (!url || !根) return null;
  let u, r;
  try {
    u = new URL(url);
    r = new URL(根);
  } catch {
    return null;
  }
  if (u.origin !== r.origin) return null;
  if (u.pathname === "/" || 不记的.test(u.pathname)) return null;
  return `${u.pathname}${u.search}`;
}

/** 记下的值还像不像一个站内应用路径：文件可能被改坏，读出来的东西要当外来数据看 */
function 像站内路径(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//")) return null;
  // 借 可恢复的路径 把同一套规矩再过一遍（登录页、API、首页都不认），顺带挡掉反斜杠这类怪写法
  return 可恢复的路径(`http://x${p}`, "http://x") === p ? p : null;
}

/** 这个账号上次停在哪一页。没记过、文件坏了、记的不像站内路径，都是 null */
function 读上次(目录) {
  if (!目录) return null;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(目录, 记录文件), "utf8"));
    return 像站内路径(c?.route);
  } catch {
    return null;
  }
}

/** 记下这个账号停在哪一页。写不进去就算了：记不住只是少一次回到原地，不能因此报错 */
function 记上次(目录, 路径) {
  if (!目录) return;
  try {
    fs.writeFileSync(path.join(目录, 记录文件), JSON.stringify({ route: 路径 }));
  } catch {
    /* 目录刚被切走、磁盘满了：都不值得打断人 */
  }
}

module.exports = { 可恢复的路径, 读上次, 记上次, 记录文件 };
