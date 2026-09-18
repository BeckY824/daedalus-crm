/**
 * 记住上次停在哪一页，重启后回到原地——包括更新之后的那次重启。
 *
 * 以前每次起来都落回 /dashboard：装个更新回来，刚看到一半的客户记录没了，得自己再翻。
 * 只记同一个站里的**应用路径**；登录、找回密码、API、后台这些不是"你工作的地方"，
 * 记了反而把人送回门口。首页也不记——它本来就是默认落点，记了等于没记。
 *
 * 纯函数、不引 electron：main.js 里的东西测不了，这一小段单独拎出来测。
 */
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

module.exports = { 可恢复的路径 };
