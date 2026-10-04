/**
 * 团队版多台实测的零件（2026-10-04，上线前测试 4.1）：起进程、按进程号关、HTTP、调 Server Action、读库、等条件。
 * 编排和断言在 run.mjs，这里不写任何「该是什么样」。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const 根 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const 包 = path.join(根, "desktop/server-bundle");

/* ---------------- 出错：说清是哪一步、哪台、期望什么、实际什么 ---------------- */

export class 断言失败 extends Error {
  constructor({ 步骤, 哪台, 期望, 实际 }) {
    super(`【${步骤}】${哪台 ? `（${哪台}）` : ""}\n    期望：${期望}\n    实际：${实际}`);
    Object.assign(this, { 步骤, 哪台, 期望, 实际 });
  }
}

export const 停 = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等到 取() 的结果让 满足() 为真，超时就红。返回满足那一刻的值和用了多久。
 * 取() 抛错不算失败（服务正忙、库被锁），记下最后一次的错，超时时一起报。
 * 迟到也报（毫秒）：超时之后再看这么久，分清「慢了，第几秒才到」和「根本没到」——前者是同步节奏的问题，后者是丢了。
 */
export async function 等到({ 步骤, 哪台, 期望, 取, 满足, 超时, 间隔 = 150, 迟到也报 = 0 }) {
  const 起 = Date.now();
  let 值, 错;
  const 看一眼 = async () => {
    try {
      值 = await 取();
      错 = undefined;
      return 满足(值);
    } catch (e) {
      错 = e;
      return false;
    }
  };
  for (;;) {
    if (await 看一眼()) return { 值, 用时: Date.now() - 起 };
    if (Date.now() - 起 > 超时) break;
    await 停(间隔);
  }
  const 超时那刻 = 错 ? `出错：${错.message ?? 错}` : 显示(值);
  while (Date.now() - 起 < 超时 + 迟到也报) {
    await 停(间隔);
    if (await 看一眼()) {
      throw new 断言失败({ 步骤: `${步骤}（${超时 / 1000} 秒内）`, 哪台, 期望, 实际: `慢了：第 ${((Date.now() - 起) / 1000).toFixed(1)} 秒才到（超时那一刻：${超时那刻}）` });
    }
  }
  throw new 断言失败({ 步骤: `${步骤}（${超时 / 1000} 秒内）`, 哪台, 期望, 实际: 迟到也报 ? `又多等 ${迟到也报 / 1000} 秒也没到：${超时那刻}` : 超时那刻 });
}

export function 显示(v) {
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return String(v);
  }
}

export function 判(条件, { 步骤, 哪台, 期望, 实际 }) {
  if (!条件) throw new 断言失败({ 步骤, 哪台, 期望, 实际: 显示(实际) });
}

/* ---------------- 进程：各自一个进程组，关的时候按进程号（组号 = 进程号）关 ---------------- */

const 起过的 = [];

/**
 * 起一个后台进程，输出进日志文件。detached = 自成一个进程组，组号就是它的进程号：
 * 关的时候 kill(-进程号) 连它派生的子进程一起关，不留孤儿，也绝不按名字去找进程（2026-10-03 pkill 误杀过用户的渲染进程）。
 */
export function 起进程(名字, cmd, args, { cwd, env, 日志 }) {
  const out = fs.openSync(日志, "a");
  const p = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
  fs.closeSync(out);
  const 项 = { 名字, pid: p.pid, 日志, 退了: false, 退出码: null };
  p.on("exit", (code, sig) => {
    项.退了 = true;
    项.退出码 = code ?? sig;
  });
  起过的.push(项);
  return 项;
}

function 活着(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 按进程号关掉起过的全部进程：先 TERM 整组，5 秒没走再 KILL。返回没关掉的（应当为空） */
export async function 全关() {
  for (const p of 起过的) {
    if (!p.退了) {
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {
        /* 已经走了 */
      }
    }
  }
  const 限 = Date.now() + 5000;
  while (Date.now() < 限 && 起过的.some((p) => 活着(p.pid))) await 停(100);
  for (const p of 起过的) {
    if (活着(p.pid)) {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        /* 已经走了 */
      }
    }
  }
  await 停(200);
  const 剩 = 起过的.filter((p) => 活着(p.pid));
  起过的.length = 0;
  return 剩;
}

export function 日志尾巴(文件, 行 = 25) {
  try {
    return fs.readFileSync(文件, "utf8").trimEnd().split("\n").slice(-行).join("\n");
  } catch {
    return "（没有日志）";
  }
}

/** 跑完才返回。看得见 = 输出直接打到屏幕上（构建要一分钟，别让人对着空屏幕等） */
export function 同步跑(cmd, args, { cwd = 根, env, 看得见 = false } = {}) {
  return execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: 看得见 ? "inherit" : ["ignore", "pipe", "pipe"] });
}

/* ---------------- HTTP：每台一个 cookie 罐 ---------------- */

export class 会话 {
  constructor(名字, base) {
    this.名字 = 名字;
    this.base = base;
    this.罐 = new Map();
  }
  cookie() {
    return [...this.罐].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  收(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv, ...属性] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      const 过期 = 属性.some((a) => /max-age=0\b/i.test(a.trim())) || v === "";
      if (过期) this.罐.delete(k);
      else this.罐.set(k, v);
    }
  }
  async 请求(路径, init = {}) {
    const res = await fetch(`${this.base}${路径}`, {
      redirect: "manual",
      ...init,
      headers: { ...(this.罐.size ? { Cookie: this.cookie() } : {}), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(init.超时 ?? 60_000),
    });
    this.收(res);
    return res;
  }
  async 页面(路径) {
    const res = await this.请求(路径);
    const text = await res.text();
    return { 状态: res.status, 跳到: res.headers.get("location"), text };
  }
  async json(方法, 路径, body, headers = {}) {
    const res = await this.请求(路径, {
      method: 方法,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* 不是 JSON */
    }
    return { 状态: res.status, json: j, text };
  }
}

/* ---------------- Server Action：和浏览器发的同一个请求 ---------------- */

/**
 * 从构建产物的 server-reference-manifest 里按「文件 + 导出名」找动作编号和一个挂着它的页面。
 * 界面上点按钮发的就是这个请求（POST 到页面、头里带 Next-Action），所以不用开浏览器也走的是同一段服务端代码。
 */
export function 读动作表(manifest文件) {
  const m = JSON.parse(fs.readFileSync(manifest文件, "utf8"));
  const 表 = new Map();
  for (const [id, e] of Object.entries(m.node ?? {})) {
    if (!e.filename || !e.exportedName) continue;
    const 页们 = Object.keys(e.workers ?? {}).map(页面路径).filter(Boolean).sort((a, b) => 分(a) - 分(b));
    表.set(`${e.filename}#${e.exportedName}`, { id, 页: 页们[0] ?? "/" });
  }
  return 表;
}
/** 「app/(app)/settings/page」→「/settings」；平行路由、拦截路由、接口路由不要 */
function 页面路径(worker) {
  if (!worker.endsWith("/page") || /\/@|\(\.+\)|\/route$/.test(worker)) return null;
  const 段 = worker.replace(/^app/, "").replace(/\/page$/, "").split("/").filter((s) => s && !/^\(.*\)$/.test(s));
  return `/${段.map((s) => (s.startsWith("[") ? "x" : s)).join("/")}`;
}
const 分 = (p) => (p.includes("/x") ? 100 : 0) + p.length;

/**
 * 调一个 Server Action，返回它的返回值。返回体是 RSC 流：第 0 行 {"a":"$@1",…} 指着结果在哪一行。
 * 参数只用纯 JSON（字符串别以 $ 开头）——React 的 encodeReply 对这种值的编码就是 JSON.stringify。
 */
export async function 调动作(会, 动作表, 键, 参数, { 页, 查询 = "" } = {}) {
  const a = 动作表.get(键);
  if (!a) throw new Error(`构建产物里没有这个 Server Action：${键}（改过名字？重新 build:server）`);
  const 地址 = `${页 ?? a.页}${查询}`;
  const res = await 会.请求(地址, {
    method: "POST",
    headers: {
      "Next-Action": a.id,
      Accept: "text/x-component",
      "Content-Type": "text/plain;charset=UTF-8",
      Origin: 会.base,
    },
    body: JSON.stringify(参数),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${键} 回了 ${res.status}：${text.slice(0, 300)}`);
  return 解RSC(text, 键);
}

function 解RSC(text, 键) {
  const 行 = new Map();
  for (const l of text.split("\n")) {
    const m = /^([0-9a-f]+):(.*)$/.exec(l);
    if (m) 行.set(m[1], m[2]);
  }
  const 首 = 行.get("0");
  if (!首) throw new Error(`${键} 的返回看不懂：${text.slice(0, 300)}`);
  const 零 = JSON.parse(首);
  let v = 零.a;
  const 引 = typeof v === "string" && /^\$@([0-9a-f]+)$/.exec(v);
  if (引) {
    const 原 = 行.get(引[1]);
    if (原 == null) throw new Error(`${键} 的返回缺第 ${引[1]} 行：${text.slice(0, 300)}`);
    if (原.startsWith("E")) throw new Error(`${键} 在服务端抛错：${原.slice(1, 400)}`);
    v = JSON.parse(原);
  }
  return v;
}

/* ---------------- 读库：只读打开，只拿来核对「每台都有全队数据」这类界面上看不到的事 ---------------- */

export function 查库(库文件, sql, ...参数) {
  const db = new DatabaseSync(库文件, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    return db.prepare(sql).all(...参数);
  } finally {
    db.close();
  }
}
