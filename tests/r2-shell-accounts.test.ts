/**
 * R2 · 桌面端账号与数据目录：把「装好 → 登录 → 退出 → 换人 → 重启」各种顺序整条模拟一遍。
 *
 * 真跑的部分：
 *   - desktop/accounts.js（认领 / 迁移旧数据 / 当前目录 / 归谁）——原样 require
 *   - desktop/cloud.js（壳那份：读、校验）——原样 require，fetch 换成假云端
 *   - src/lib/desktop/cloud.ts（服务端那份：登录、退出、归属对不上）——原样 import
 * 照抄的部分（main.js 引 electron，测不了；**应该抽成纯模块**，见报告）：
 *   - 启动那一段（迁移旧数据 → 当前目录 → 校验 5 秒 → 认领 → 搬令牌）
 *   - 看凭据换没换()、切一次()、搬令牌()
 *   - 页面：桌面端登录()（换了账号就喊 shell:switch-account）、(app)/layout 的两道闸
 *
 * 「用户看到的」= 本地服务那个 CRM_DATA_DIR 里的 crm.db，前提是过了 layout 的闸
 * （有令牌、归属对得上）。crm.db 在这里是一份 JSON 记账：谁在什么时候写了哪一笔。
 *
 * 两条不变式，每一步之后都查：
 *   不串：任何一个目录里只能有一个人写的东西；进门的人看到的全是他自己的
 *   不丢：进门的人看得到他以前写过的每一笔
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const 账号 = require_("../desktop/accounts.js");
const 壳云端 = require_("../desktop/cloud.js");

/* ------------------------------------------------------------------ */
/* 假云端                                                              */
/* ------------------------------------------------------------------ */

type 云端账号 = { id: string; target: string; name: string };
const 甲: 云端账号 = { id: "acc_jia", target: "jia@x.com", name: "甲" };
const 乙: 云端账号 = { id: "acc_yi", target: "yi@x.com", name: "乙" };
const 丙: 云端账号 = { id: "acc_bing", target: "bing@x.com", name: "丙" };
const 全部账号 = [甲, 乙, 丙];

class 假云端 {
  在线 = true;
  /** 连得上但不回（酒店网）：壳启动只等 5 秒，这里直接当超时 */
  慢 = false;
  令牌 = new Map<string, string>(); // token → accountId
  吊销了 = new Set<string>();
  private n = 0;

  吊销全部(accountId: string) {
    for (const [t, id] of this.令牌) if (id === accountId) this.吊销了.add(t);
  }

  fetch = async (url: string, init: RequestInit = {}) => {
    if (!this.在线) throw new TypeError("fetch failed");
    if (this.慢) {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      throw e;
    }
    const u = new URL(String(url));
    const auth = new Headers(init.headers).get("Authorization") ?? (init.headers as Record<string, string> | undefined)?.Authorization ?? "";
    const t = String(auth).replace(/^Bearer /, "");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/api/account/token" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      const a = 全部账号.find((x) => x.target === body.target);
      if (!a || body.password !== "pw") return json({ error: "账号或密码不对" }, 401);
      const tok = `t-${a.id}-${++this.n}`;
      this.令牌.set(tok, a.id);
      return json({ token: tok, account: { id: a.id, name: a.name, contact: a.target }, credits: { 还剩: 30 } });
    }
    if (u.pathname === "/api/account/token" && init.method === "DELETE") {
      this.吊销了.add(t);
      return json({ ok: true });
    }
    const id = this.令牌.get(t);
    if (!id || this.吊销了.has(t)) return json({ error: "令牌无效" }, 401);
    if (u.pathname === "/api/gateway/v1/models") return json({ data: [{ id: "deepseek-v4.1-flash" }] });
    if (u.pathname === "/api/gateway/v1/credits") return json({ 上限: 30, 用掉: 0, 还剩: 30, accountId: id });
    return json({ error: "not found" }, 404);
  };
}

/* ------------------------------------------------------------------ */
/* 照抄 main.js 的那几段（行号见报告）                                   */
/* ------------------------------------------------------------------ */

type 记账 = { 谁: string; 第几: number }[];

/**
 * 库里那个管理员 User 行的 email（2026-10-04 加，剩余风险 1）。真库里它由 desktop/server-entry.js 每次启动
 * 对成 .cloud.json 的 contact、登录动作（login/actions.ts，没换账号时）也会对一遍；新库是种子里的 "admin"。
 * 这里拿目录里一个小文件扮演它，服务端那份经 设库里我的邮箱读法() 读这个文件。
 */
const 管理员邮箱文件 = "admin-email.txt";
const 写管理员邮箱 = (dir: string, 邮箱: string) => fs.writeFileSync(path.join(dir, 管理员邮箱文件), 邮箱.trim().toLowerCase());
const 读管理员邮箱 = (dir: string) => {
  try {
    return fs.readFileSync(path.join(dir, 管理员邮箱文件), "utf8");
  } catch {
    return "admin";
  }
};
const 读库 = (dir: string): 记账 => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "crm.db"), "utf8"));
  } catch {
    return [];
  }
};

class 一台电脑 {
  数据目录 = "";
  /** 本地服务：起着就是它连着的那个目录（CRM_DATA_DIR 是启动时烤进去的字符串） */
  本地: { dir: string } | null = null;
  /** 页面那座桥（shell:switch-account）在不在 */
  有桥 = true;
  /** Windows：切账号前先停服务（main.js 切一次 的 先停） */
  win32 = false;
  /** 页面落在哪：null = 没窗口 */
  页面: "登录页" | "挡住(switched)" | "进门" | null = null;
  事件: string[] = [];

  constructor(public 根: string) {}

  private 换数据目录(dir: string) {
    this.数据目录 = dir;
    壳云端.初始化(dir);
  }

  /** main.js:136-150 搬令牌 */
  private 搬令牌(从: string, 到: string) {
    if (从 === 到) return;
    try {
      const 旧 = path.join(从, ".cloud.json");
      if (!fs.existsSync(旧)) return;
      fs.mkdirSync(到, { recursive: true });
      fs.copyFileSync(旧, path.join(到, ".cloud.json"));
      fs.rmSync(旧, { force: true });
    } catch (e) {
      this.事件.push(`搬令牌失败 ${String(e)}`);
    }
  }

  private 起服务() {
    this.本地 = { dir: this.数据目录 };
    // desktop/server-entry.js：启动时把管理员的邮箱对成 .cloud.json 的 contact
    const c = 壳云端.读();
    if (c?.contact) 写管理员邮箱(this.数据目录, c.contact);
  }
  private 停服务() {
    this.本地 = null;
  }

  /** 服务端那份代码在哪个目录上跑：就是本地服务启动时拿到的 CRM_DATA_DIR */
  private 服务端环境() {
    if (!this.本地) throw new Error("本地服务没起来");
    process.env.DESKTOP_LOCAL = "1";
    process.env.CRM_DATA_DIR = this.本地.dir;
  }

  /** main.js 模块顶层 + whenReady（:169-180、:1341-1377） */
  async 启动() {
    try {
      账号.迁移旧数据(this.根, 壳云端.读账号id);
    } catch (e) {
      this.事件.push(`迁移旧数据失败 ${String(e)}`);
    }
    this.换数据目录(账号.当前目录(this.根).目录);
    let 被吊销 = false;
    if (壳云端.读()) {
      const r = await 壳云端.校验(5_000);
      被吊销 = r.原因 === "已吊销";
      if (r.accountId) {
        try {
          const 目标 = 账号.认领(this.根, r.accountId, 壳云端.读()?.contact);
          if (目标.换了目录) this.搬令牌(this.数据目录, 目标.目录);
          this.换数据目录(目标.目录);
        } catch (e) {
          this.事件.push(`认领失败 ${String(e)}`);
        }
      }
    }
    this.起服务();
    await this.打开窗口(被吊销 ? "revoked" : undefined);
  }

  退出应用() {
    this.停服务();
    this.页面 = null;
  }

  /** main.js:152-166 看凭据换没换（fs.watch 那条路） */
  async 看凭据换没换() {
    if (!this.本地) return;
    const c = 壳云端.读();
    if (!c?.accountId) return;
    if (账号.是他的(this.数据目录, c.accountId) !== false) return;
    await this.切一次();
  }

  /** main.js:1179-1213 切一次 */
  async 切一次() {
    const c = 壳云端.读();
    if (!c?.accountId) return { ok: false };
    const 先停 = this.win32 && !!this.本地;
    if (先停) this.停服务();
    let 目标;
    try {
      目标 = 账号.认领(this.根, c.accountId, c.contact);
    } catch (e) {
      if (先停) this.起服务();
      this.事件.push(`换账号失败 ${String(e)}`);
      return { ok: false };
    }
    if (目标.换了目录 || 先停) {
      this.搬令牌(this.数据目录, 目标.目录);
      this.换数据目录(目标.目录);
      this.停服务();
      this.起服务();
    }
    await this.打开窗口();
    return { ok: true };
  }

  /**
   * 窗口载入本地入口：/api/desktop/session（有令牌、对得上就签会话）→ 落到 (app)/layout。
   * 没令牌 → 登录页；归属对不上 → logout?reason=switched → 登录页（带着那句话）
   */
  async 打开窗口(reason?: string) {
    const { 读, 归属对不上 } = await import("@/lib/desktop/cloud");
    this.服务端环境();
    if (reason === "revoked") this.页面 = "登录页";
    else if (!读()) this.页面 = "登录页";
    else if (归属对不上()) this.页面 = "挡住(switched)";
    else this.页面 = "进门";
  }

  /** 登录页上点「登录」：login/actions.ts 桌面端登录 */
  async 登录(a: 云端账号) {
    if (this.页面 === "进门") throw new Error("已经进门了，登录页不在");
    const { 登录 } = await import("@/lib/desktop/cloud");
    this.服务端环境();
    const r = await 登录(a.target, "pw");
    if (!r.ok) {
      this.事件.push(`登录失败 ${r.error}`);
      return r;
    }
    if (r.data.换了账号) {
      // 页面喊一声（桥在时）；fs.watch 那条路随后也会到，两条路进同一个 切账号
      if (this.有桥) await this.切一次();
      await this.看凭据换没换();
      if (!this.有桥) await this.打开窗口(); // 页面落回自动登录那条路
    } else {
      // login/actions.ts 桌面端登录：没换账号才往本机库里写——管理员邮箱对成这个账号的
      写管理员邮箱(this.本地!.dir, r.data.contact || a.target);
      await this.看凭据换没换();
      await this.打开窗口();
    }
    return r;
  }

  /** 左下角「退出登录」：POST /api/auth/logout → 吊销 + 删 .cloud.json */
  async 退出登录() {
    const { 退出 } = await import("@/lib/desktop/cloud");
    this.服务端环境();
    await 退出();
    await this.看凭据换没换();
    this.页面 = "登录页";
  }

  /** 切回应用（browser-window-focus）：main.js:1420-1425 */
  async 切回前台() {
    if (!壳云端.读()) return;
    const r = await 壳云端.校验().catch(() => ({ 有效: true }));
    if (!r.有效) this.页面 = "登录页";
  }

  /**
   * 进门的话：是谁、看到的是哪个目录。
   * 老 .cloud.json（0.39.2 之前）里没有 accountId：断网开机照常进门，那时人是谁按令牌在云端归谁算
   * （2026-10-04 加：原来记成「?」，升级上来的甲断网进门看自己那份会被误报成串数据）
   */
  认令牌: (token: string) => string | undefined = () => undefined;
  async 看到() {
    if (this.页面 !== "进门" || !this.本地) return null;
    const { 读 } = await import("@/lib/desktop/cloud");
    this.服务端环境();
    const c = 读();
    return c ? { 谁: c.accountId ?? this.认令牌(c.token) ?? "?", 目录: this.本地.dir } : null;
  }
}

/* ------------------------------------------------------------------ */
/* 场景机：每一步之后查两条不变式                                         */
/* ------------------------------------------------------------------ */

type 步 =
  | "甲登录" | "乙登录" | "丙登录" | "甲登录(桥断)" | "乙登录(桥断)"
  | "退出登录" | "重启" | "重启(断网)" | "重启(网慢)" | "写一笔" | "吊销甲" | "吊销乙" | "切回前台"
  /* 2026-10-04 加（A-2 / B-2 / C-7）：断网时点退出；当前目录的 .owner 被清空（磁盘满、杀毒软件） */
  | "退出登录(断网)" | "清空.owner";

class 场景 {
  机: 一台电脑;
  云 = new 假云端();
  写过: Record<string, number[]> = {};
  违规: string[] = [];
  private n = 0;
  走过: string[] = [];

  constructor(public 根: string) {
    this.机 = new 一台电脑(根);
    this.机.认令牌 = (t) => this.云.令牌.get(t);
    vi.stubGlobal("fetch", this.云.fetch);
  }

  async 开机() {
    await this.机.启动();
  }

  async 走(s: 步) {
    this.走过.push(s);
    const m = this.机;
    const 账号表: Record<string, 云端账号> = { 甲, 乙, 丙 };
    switch (s) {
      case "甲登录":
      case "乙登录":
      case "丙登录":
      case "甲登录(桥断)":
      case "乙登录(桥断)": {
        if (m.页面 === "进门") return; // 登录页不在，这一步不存在
        m.有桥 = !s.includes("桥断");
        await m.登录(账号表[s[0]]);
        m.有桥 = true;
        break;
      }
      case "退出登录":
        if (m.页面 !== "进门") return;
        await m.退出登录();
        break;
      case "退出登录(断网)":
        if (m.页面 !== "进门") return;
        this.云.在线 = false;
        await m.退出登录();
        this.云.在线 = true;
        break;
      case "清空.owner":
        if (m.数据目录 && fs.existsSync(path.join(m.数据目录, ".owner"))) fs.writeFileSync(path.join(m.数据目录, ".owner"), "");
        break;
      case "重启":
      case "重启(断网)":
      case "重启(网慢)":
        m.退出应用();
        this.云.在线 = s !== "重启(断网)";
        this.云.慢 = s === "重启(网慢)";
        await m.启动();
        this.云.在线 = true;
        this.云.慢 = false;
        break;
      case "写一笔": {
        const 我 = await m.看到();
        if (!我) return;
        const 库 = 读库(我.目录);
        const 第几 = ++this.n;
        库.push({ 谁: 我.谁, 第几 });
        fs.writeFileSync(path.join(我.目录, "crm.db"), JSON.stringify(库));
        (this.写过[我.谁] ??= []).push(第几);
        break;
      }
      case "吊销甲":
        this.云.吊销全部(甲.id);
        break;
      case "吊销乙":
        this.云.吊销全部(乙.id);
        break;
      case "切回前台":
        await m.切回前台();
        break;
    }
    await this.查();
  }

  async 查() {
    const 账号根 = path.join(this.根, "accounts");
    const 目录们 = fs.existsSync(账号根) ? fs.readdirSync(账号根).map((d) => path.join(账号根, d)) : [];
    for (const d of 目录们) {
      const 作者 = new Set(读库(d).map((x) => x.谁));
      if (作者.size > 1) this.违规.push(`【串数据】${path.basename(d)} 里混着 ${[...作者].join(" + ")}（${this.走过.join(" → ")}）`);
    }
    const 我 = await this.机.看到();
    if (!我) return;
    const 看得到 = 读库(我.目录);
    const 别人的 = 看得到.filter((x) => x.谁 !== 我.谁);
    if (别人的.length) this.违规.push(`【串数据】${我.谁} 进门看到别人的 ${别人的.length} 笔（${this.走过.join(" → ")}）`);
    const 有 = new Set(看得到.filter((x) => x.谁 === 我.谁).map((x) => x.第几));
    const 丢了 = (this.写过[我.谁] ?? []).filter((k) => !有.has(k));
    if (丢了.length) this.违规.push(`【丢数据】${我.谁} 进门看不到自己写过的 ${丢了.length} 笔（${this.走过.join(" → ")}）`);
  }
}

let 根: string;
beforeEach(async () => {
  根 = fs.mkdtempSync(path.join(os.tmpdir(), "r2-accounts-"));
  // 服务端那份读「库里管理员的邮箱」默认走 prisma；这里的库是 JSON 记账，换成读那个小文件
  const 服务端 = await import("@/lib/desktop/cloud");
  服务端.设库里我的邮箱读法(async () => (process.env.CRM_DATA_DIR ? 读管理员邮箱(process.env.CRM_DATA_DIR) : null));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  fs.rmSync(根, { recursive: true, force: true });
});

async function 跑(步们: 步[], 准备?: (根: string) => void) {
  准备?.(根);
  const s = new 场景(根);
  await s.开机();
  for (const x of 步们) await s.走(x);
  return s;
}

/* ------------------------------------------------------------------ */

describe("主线：第一次装 → 甲 → 乙 → 甲 → 重启", () => {
  it("中途重启过一次（甲那份已被改名认领）：全程不串、不丢", async () => {
    const s = await 跑(["甲登录", "写一笔", "重启", "退出登录", "乙登录", "写一笔", "退出登录", "甲登录", "写一笔", "重启", "写一笔"]);
    expect(s.违规).toEqual([]);
    expect(s.机.页面).toBe("进门");
  });

  /*
    【A · 真坏】第一次装好，甲登录录了客户、**没重启过**就退出；乙登录（切到乙的新目录，指针=乙）、退出；
    甲再登录：认领() 只在「指针为空」时才把 _未认领 改名给他（accounts.js:177），
    而 main.js 从来不调 accounts.退出()，指针一直是乙 → 甲被换进一个**新建的空目录**，
    他那份客户永远留在 _未认领 里，重启也认领不回来。界面上就是「我的客户全没了」。
  */
  it("【A-1 真坏】甲没重启过就退出、乙登过一次：甲再回来要看到自己的客户", async () => {
    const s = await 跑(["甲登录", "写一笔", "退出登录", "乙登录", "写一笔", "退出登录", "甲登录", "重启"]);
    expect(s.违规).toEqual([]);
  });

  it.skip("【已修，旁证作废】A-1 的旁证：甲的客户还在磁盘上（_未认领 里），只是指不到", async () => {
    const s = await 跑(["甲登录", "写一笔", "退出登录", "乙登录", "退出登录", "甲登录", "重启"]);
    const 未认领 = 账号.账号目录(根, 账号.未认领);
    expect(读库(未认领).map((x) => x.谁)).toEqual([甲.id]);
    expect(账号.归谁(未认领)).toBe(甲.id);
    const 我 = await s.机.看到();
    expect(我?.谁).toBe(甲.id);
    expect(我?.目录).toBe(账号.账号目录(根, 账号.key(甲.id)));
    expect(读库(我!.目录)).toEqual([]); // 甲进门看到的是空库
  });

  it("页面的桥断了（只靠 fs.watch）：乙登录也换到自己的目录，看不到甲的", async () => {
    const s = await 跑(["甲登录", "写一笔", "重启", "退出登录", "乙登录(桥断)", "写一笔", "退出登录", "甲登录(桥断)", "写一笔"]);
    expect(s.违规).toEqual([]);
  });

  it("Windows（先停服务再改名）走一遍同一条主线", async () => {
    const s = new 场景(根);
    s.机.win32 = true;
    await s.开机();
    for (const x of ["甲登录", "写一笔", "重启", "退出登录", "乙登录", "写一笔", "退出登录", "甲登录", "写一笔"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
  });
});

describe("断网 / 网慢 / 令牌被吊销", () => {
  it("断网点登录：什么都不写，目录、归属、指针都不动", async () => {
    const s = new 场景(根);
    await s.开机();
    s.云.在线 = false;
    const r = await s.机.登录(甲);
    expect(r.ok).toBe(false);
    expect(账号.归谁(账号.账号目录(根, 账号.未认领))).toBeNull();
    expect(账号.读指针(根)).toBeNull();
    expect(s.机.页面).toBe("登录页");
  });

  it("已登录断网重启：照常进门、看得到自己的数据（问不到当作还认）", async () => {
    const s = await 跑(["甲登录", "写一笔", "重启(断网)", "写一笔", "重启(网慢)", "写一笔", "重启"]);
    expect(s.违规).toEqual([]);
    expect(s.机.页面).toBe("进门");
  });

  it("令牌被吊销：重启后回登录页、本机数据一笔不少；重新登录回到原目录", async () => {
    const s = await 跑(["甲登录", "写一笔", "重启", "吊销甲", "重启"]);
    expect(s.机.页面).toBe("登录页");
    expect(壳云端.读()).toBeNull(); // 本地那枚被清掉了
    await s.走("甲登录");
    expect(s.违规).toEqual([]);
    expect((await s.机.看到())?.谁).toBe(甲.id);
  });

  it("令牌被吊销、没重启，切回前台就被请回登录页", async () => {
    const s = await 跑(["甲登录", "写一笔", "吊销甲"]);
    await s.机.切回前台();
    expect(s.机.页面).toBe("登录页");
  });

  /*
    【B · 缺口】乙在甲的目录上登录（令牌先落在甲的目录里），壳还没来得及切（应用被关 / 崩了），
    下次**断网**启动：校验() 断网时不回 accountId（desktop/cloud.js:102），于是不认领，
    服务起在甲的目录上 → 闸挡住（不串，好），但乙断网时永远进不去自己那份——
    令牌里明明就写着 accountId。
    2026-10-04 修：校验() 问不到时带回本地 .cloud.json 记着的 accountId，开机照样认领到乙自己的目录。
  */
  it("【B-1 · 2026-10-04 修】乙登录后没切成就关了应用，断网再开：乙应该落到自己的目录", async () => {
    const s = await 跑(["甲登录", "写一笔", "重启", "退出登录"]);
    // 乙登录：服务端那份把乙的令牌写进甲的目录，返回 换了账号；这里模拟壳没来得及切
    const { 登录 } = await import("@/lib/desktop/cloud");
    process.env.CRM_DATA_DIR = s.机.本地!.dir;
    const r = await 登录(乙.target, "pw");
    expect(r.ok && r.data.换了账号).toBe(true);
    await s.走("重启(断网)");
    expect(s.违规).toEqual([]); // 不串
    expect(s.机.页面).toBe("进门");
  });
});

describe("升级：0.39.2 之前那份 data/", () => {
  const 造旧数据 = (带账号: boolean) => (r: string) => {
    const d = path.join(r, "data");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "crm.db"), JSON.stringify([{ 谁: 甲.id, 第几: 0 }]));
    fs.writeFileSync(path.join(d, ".cloud.json"), JSON.stringify({ baseUrl: "http://cloud.test", token: "t-old-jia", ...(带账号 ? { accountId: 甲.id } : {}), name: "甲", contact: 甲.target, models: [] }));
    写管理员邮箱(d, 甲.target);
  };
  const 认老令牌 = (s: 场景) => s.云.令牌.set("t-old-jia", 甲.id);

  it(".cloud.json 带 accountId：开机就认领给甲，之后乙登录看不到", async () => {
    造旧数据(true)(根);
    const s = new 场景(根);
    认老令牌(s);
    s.写过[甲.id] = [0];
    await s.开机();
    for (const x of ["写一笔", "退出登录", "乙登录", "写一笔", "退出登录", "甲登录", "重启"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
  });

  it(".cloud.json 没有 accountId（0.39.2 之前写的）：联网开机从云端问出是谁再认领", async () => {
    造旧数据(false)(根);
    const s = new 场景(根);
    认老令牌(s);
    s.写过[甲.id] = [0];
    await s.开机();
    expect(账号.读指针(根)).toBe(账号.key(甲.id));
    for (const x of ["退出登录", "乙登录", "写一笔", "退出登录", "甲登录"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
  });

  /*
    【A · 真坏，触发面窄】老 .cloud.json 没有 accountId，而升级后头几次开机都没在 5 秒内问到云端
    （断网 / 网慢——本轮把启动校验从 20 秒缩到 5 秒，这个窗口变宽了）：那份数据留在 _未认领、**没有 .owner**。
    这期间甲退出、乙登录 → 服务端 登录() 看到「没主」就把 .owner 记成乙（lib/desktop/cloud.ts:271），换了账号=false，
    乙直接进了甲的库，甲的客户归了乙。和本轮修的 A2 是同一个坑，只是入口换成了「升级上来的那份」。
  */
  it("【A-2 · 2026-10-04 修】升级后断网开机、甲退出、乙登录：乙不许进甲的库", async () => {
    造旧数据(false)(根);
    const s = new 场景(根);
    认老令牌(s);
    s.写过[甲.id] = [0];
    s.云.在线 = false;
    await s.开机();
    s.云.在线 = true;
    expect(s.机.页面).toBe("进门");
    for (const x of ["退出登录", "乙登录", "写一笔"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
  });

  it("【A-2 · 2026-10-04 修】同上，只是网慢（>5 秒）而不是断网", async () => {
    造旧数据(false)(根);
    const s = new 场景(根);
    认老令牌(s);
    s.写过[甲.id] = [0];
    s.云.慢 = true;
    await s.开机();
    s.云.慢 = false;
    for (const x of ["退出登录", "乙登录", "写一笔"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
  });

  /*
    A-2 修法（2026-10-04）的两条岔路：退出那一下也没问到（断网开机、断网退出）→ 令牌挪去待认，
    下一次有人登录时（那时一定连得上）再问。问出是甲 → 乙去新目录、甲回来还拿得到自己那份。
  */
  it("【A-2 · 2026-10-04 修】断网开机又断网退出：乙登录进新目录，甲回来拿回升级上来的那份", async () => {
    造旧数据(false)(根);
    const s = new 场景(根);
    认老令牌(s);
    s.写过[甲.id] = [0];
    s.云.在线 = false;
    await s.开机();
    await s.走("退出登录");
    // 问不到是谁：令牌没吊销，挪去待认留作凭据；这份算「有主、认不出」
    expect(fs.existsSync(path.join(账号.账号目录(根, 账号.未认领), 账号.待认文件))).toBe(true);
    expect(账号.归谁(账号.账号目录(根, 账号.未认领))).toBe(账号.认不出的主);
    s.云.在线 = true;
    for (const x of ["乙登录", "写一笔", "退出登录", "甲登录", "写一笔", "重启"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
    expect((await s.机.看到())?.谁).toBe(甲.id);
    // 待认那枚认出主之后补吊销、文件清掉
    expect(s.云.吊销了.has("t-old-jia")).toBe(true);
  });

  /*
    待认那枚老令牌在下次登录前就作废了（甲在网页上改了密码），令牌问不出是谁。
    原先（A-2 修法第一版）只能记成认不出、甲回来也拿不到；剩余风险 1 修了之后改看库里管理员的邮箱：
    乙登录记成「主人是甲的邮箱」、进新目录；甲回来 contact 对得上，拿得回。断言跟着改（2026-10-04）
  */
  it("【A-2 · 2026-10-04 修】待认的老令牌已作废：乙进新目录，甲凭库里的邮箱拿回那份", async () => {
    造旧数据(false)(根);
    const s = new 场景(根);
    认老令牌(s);
    s.写过[甲.id] = [0];
    s.云.在线 = false;
    await s.开机();
    await s.走("退出登录");
    s.云.在线 = true;
    s.云.吊销全部(甲.id);
    for (const x of ["乙登录", "写一笔"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
    const 未认领 = 账号.账号目录(根, 账号.未认领);
    expect(读库(未认领)).toEqual([{ 谁: 甲.id, 第几: 0 }]);
    expect(账号.归谁(未认领)).toBe(账号.邮箱记号(甲.target));
    expect(fs.existsSync(path.join(未认领, 账号.待认文件))).toBe(false);
    for (const x of ["退出登录", "甲登录", "写一笔", "重启"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
    expect((await s.机.看到())?.谁).toBe(甲.id);
  });

  /*
    取舍（2026-10-04，A-2）：同上，而库里也没有可比的邮箱（老令牌里没有 contact、管理员邮箱还是种子里的 admin）——这份是谁的彻底认不出。
    选「绝不串」：记成认不出，谁都领不走，数据原地留在 _未认领 里一个字节不动——代价是甲回来也看不到它（要人工搬）。
  */
  it("【A-2 · 2026-10-04 修】待认的老令牌已作废、库里也没邮箱：谁登录都进新目录，那份原地留着不动", async () => {
    造旧数据(false)(根);
    // 库里没有可比的邮箱：老令牌里也没有 contact（server-entry 无从对起），管理员还是种子里的 admin
    fs.rmSync(path.join(根, "data", 管理员邮箱文件));
    fs.writeFileSync(path.join(根, "data", ".cloud.json"), JSON.stringify({ baseUrl: "http://cloud.test", token: "t-old-jia", name: "甲", models: [] }));
    const s = new 场景(根);
    认老令牌(s);
    s.云.在线 = false;
    await s.开机();
    await s.走("退出登录");
    s.云.在线 = true;
    s.云.吊销全部(甲.id);
    for (const x of ["乙登录", "写一笔"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
    const 未认领 = 账号.账号目录(根, 账号.未认领);
    expect(读库(未认领)).toEqual([{ 谁: 甲.id, 第几: 0 }]);
    expect(账号.归谁(未认领)).toBe(账号.认不出的主);
    expect(fs.existsSync(path.join(未认领, 账号.待认文件))).toBe(false);
  });

  /*
    剩余风险 1（2026-10-04 修）：老令牌在开机校验时就已被吊销（甲在网页上改了密码）→ 壳按 401 清掉令牌 →
    这份没主、也没有老令牌可问。原来第一个登录的人就领走它，是乙就串库。
    现在看库里管理员的邮箱（server-entry 每次启动对成云端账号 contact 的，老库也是）：
    登录者的 contact 对得上才许认领，对不上算换了账号进新空目录；甲改了密码回来 contact 没变，照样拿得回。
  */
  it("【风险1 · 2026-10-04 修】升级上来的老令牌开机时已被吊销：乙先登录不许领走甲的库，甲回来拿得回", async () => {
    造旧数据(false)(根);
    const s = new 场景(根);
    认老令牌(s);
    s.云.吊销全部(甲.id);
    s.写过[甲.id] = [0];
    await s.开机();
    expect(s.机.页面).toBe("登录页");
    expect(壳云端.读()).toBeNull(); // 401：壳把老令牌清掉了
    for (const x of ["乙登录", "写一笔", "退出登录", "甲登录", "写一笔", "重启"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
    expect((await s.机.看到())?.谁).toBe(甲.id);
  });

  it("【风险1 · 2026-10-04 修】同上，甲自己先回来（改了密码重新登录）：当场就是他的，不换目录", async () => {
    造旧数据(false)(根);
    const s = new 场景(根);
    认老令牌(s);
    s.云.吊销全部(甲.id);
    s.写过[甲.id] = [0];
    await s.开机();
    for (const x of ["甲登录", "写一笔", "重启", "退出登录", "乙登录", "写一笔"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
    expect(账号.读指针(根)).toBe(账号.key(乙.id));
  });

  it("【风险1 · 2026-10-04 修】从没登录过的老库（管理员邮箱还是种子里的 admin）：照旧第一个登录的人领走", async () => {
    const d = path.join(根, "data");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "crm.db"), JSON.stringify([]));
    const s = new 场景(根);
    await s.开机();
    await s.走("乙登录");
    await s.走("写一笔");
    expect(s.违规).toEqual([]);
    expect(读库(账号.账号目录(根, 账号.未认领)).map((x) => x.谁)).toEqual([乙.id]);
  });

  it("邮箱记号：壳和服务端算的是同一个值，大小写 / 空格不影响，不带邮箱原文", async () => {
    const { 邮箱记号 } = await import("@/lib/desktop/cloud");
    expect(邮箱记号(" Jia@X.com ")).toBe(账号.邮箱记号("jia@x.com"));
    expect(邮箱记号("jia@x.com")).not.toContain("jia");
    expect(邮箱记号("jia@x.com").startsWith("?")).toBe(true);
  });

  it("「认不出」的记号、待认文件名、归属校验副本的文件名：壳和服务端两份必须是同一个值", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../src/lib/desktop/cloud.ts"), "utf8");
    expect(src).toContain(`export const 认不出的主 = "${账号.认不出的主}";`);
    expect(src).toContain(`const 待认文件名 = "${账号.待认文件}";`);
    expect(src).toContain(`const 归属校验文件名 = "${账号.归属校验文件}";`);
  });

  it("迁移目标已存在（降级用过老版本又升回来）：data/ 原地不动、一个字节不丢——但界面上看不到它", async () => {
    // 先正常升级一次，甲有了自己的目录
    造旧数据(true)(根);
    const s = new 场景(根);
    认老令牌(s);
    await s.开机();
    // 又装回老版本用了一阵：老版本只认 data/
    造旧数据(true)(根);
    fs.writeFileSync(path.join(根, "data", "crm.db"), JSON.stringify([{ 谁: 甲.id, 第几: 99 }]));
    await s.走("重启");
    expect(fs.existsSync(path.join(根, "data", "crm.db"))).toBe(true); // 没丢
    const 我 = await s.机.看到();
    expect(读库(我!.目录).some((x) => x.第几 === 99)).toBe(false); // 但看不到（C：没有任何提示）
  });
});

describe(".owner 损坏 / 为空", () => {
  /*
    【B · 缺口，需要 .owner 坏掉才触发】已认领的 accounts/<甲>/ 里 .owner 是空文件（磁盘满时 记归属 写了一半、
    杀毒软件清空……；记归属 失败是吞掉的，accounts.js:77-84）。甲退出、乙登录：服务端看「没主」→ 记成乙、
    换了账号=false → 乙进了甲的库。目录名本身就是 key(甲)，拿它兜底就不会认错。
  */
  it("【B-2 · 2026-10-04 修】accounts/<甲>/.owner 被清空：乙登录不许进甲的库", async () => {
    const s = await 跑(["甲登录", "写一笔", "重启", "退出登录"]);
    fs.writeFileSync(path.join(账号.账号目录(根, 账号.key(甲.id)), ".owner"), "");
    await s.走("乙登录");
    await s.走("写一笔");
    expect(s.违规).toEqual([]);
  });

  it("【B-2 · 2026-10-04 修】accounts/<甲>/.owner 写成乱码、甲自己回来：照常进门，.owner 顺手补回", async () => {
    const s = await 跑(["甲登录", "写一笔", "重启", "退出登录"]);
    const 甲目录 = 账号.账号目录(根, 账号.key(甲.id));
    fs.writeFileSync(path.join(甲目录, ".owner"), "\u0000garbage");
    for (const x of ["乙登录", "写一笔", "退出登录", "甲登录", "写一笔", "重启"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
    expect((await s.机.看到())?.谁).toBe(甲.id);
    expect(账号.归谁(甲目录)).toBe(甲.id);
  });

  it("【B-2 · 2026-10-04 修】目录名兜底：壳的 是他的() 和服务端的 归属对不上() 认的是同一个 key", async () => {
    const 甲目录 = 账号.账号目录(根, 账号.key(甲.id));
    fs.mkdirSync(甲目录, { recursive: true });
    fs.writeFileSync(path.join(甲目录, ".owner"), "");
    expect(账号.是他的(甲目录, 甲.id)).toBe(true);
    expect(账号.是他的(甲目录, 乙.id)).toBe(false);
    expect(账号.是他的(账号.账号目录(根, 账号.未认领), 乙.id)).toBeNull(); // _未认领 没主：谁都行
    const { 归属对不上 } = await import("@/lib/desktop/cloud");
    process.env.DESKTOP_LOCAL = "1";
    process.env.CRM_DATA_DIR = 甲目录;
    const 写令牌 = (id: string) => fs.writeFileSync(path.join(甲目录, ".cloud.json"), JSON.stringify({ baseUrl: "http://cloud.test", token: "t", accountId: id, models: [] }));
    写令牌(甲.id);
    expect(归属对不上()).toBe(false);
    写令牌(乙.id);
    expect(归属对不上()).toBe(true);
  });

  it("【B-2 · 2026-10-04 修】记归属失败不再吞掉：走 设日志() 接进来的日志", () => {
    const 记 = vi.fn();
    账号.设日志(记);
    try {
      // 乙的目标目录是个文件：认领() 的 mkdir 会抛（调用方 切一次 接着报「换账号失败」），记归属 那一下要留案
      const 乙目录 = 账号.账号目录(根, 账号.key(乙.id));
      fs.mkdirSync(path.dirname(乙目录), { recursive: true });
      fs.mkdirSync(乙目录);
      fs.mkdirSync(path.join(乙目录, ".owner")); // .owner 是个目录：写不进去
      账号.认领(根, 乙.id);
      expect(记).toHaveBeenCalledTimes(1);
      expect(String(记.mock.calls[0][0])).toContain("记归属失败");
    } finally {
      账号.设日志((标题: string, e: unknown) => console.error(标题, e));
    }
  });

  /*
    原来这条的标题是「甲自己也进不去，见 C-7」。2026-10-04 修 C-7 后有了自带校验的副本（.owner.check），
    .owner 写成乱码时仍认得出是甲的：乙照样被换走（不串），甲回来也拿得回（不丢）。断言跟着收紧成全不违规
  */
  it(".owner 是乱码：乙登录被换去自己的目录，甲那份不会被别人拿走、甲回来还拿得到（C-7）", async () => {
    const s = await 跑(["甲登录", "写一笔"]);
    fs.writeFileSync(path.join(账号.账号目录(根, 账号.未认领), ".owner"), "\u0000\u0000garbage");
    await s.走("退出登录");
    await s.走("乙登录");
    await s.走("写一笔");
    for (const x of ["退出登录", "甲登录", "写一笔", "重启"] as 步[]) await s.走(x);
    expect(s.违规).toEqual([]);
    expect((await s.机.看到())?.谁).toBe(甲.id);
  });

  it("【C-7 · 2026-10-04 修】_未认领 的 .owner 被写坏，甲再登录：应该还能拿回自己那份", async () => {
    const s = await 跑(["甲登录", "写一笔"]);
    fs.writeFileSync(path.join(账号.账号目录(根, 账号.未认领), ".owner"), "garbage");
    await s.走("退出登录");
    await s.走("甲登录");
    expect(s.违规).toEqual([]);
  });

  it("【C-7 · 2026-10-04 修】.owner 和校验副本一起坏了：拿不回也绝不串——乙进新目录，那份原地不动", async () => {
    const s = await 跑(["甲登录", "写一笔"]);
    const 未认领 = 账号.账号目录(根, 账号.未认领);
    fs.writeFileSync(path.join(未认领, ".owner"), "garbage");
    fs.writeFileSync(path.join(未认领, 账号.归属校验文件), "acc_yi\nffffffffffffffffffffffff\n"); // 校验对不上：不认
    await s.走("退出登录");
    await s.走("乙登录");
    await s.走("写一笔");
    expect(s.违规).toEqual([]);
    expect(读库(未认领).map((x) => x.谁)).toEqual([甲.id]);
  });
});

describe("两个目录同名 / 已存在", () => {
  it("甲已有自己的目录，又冒出一份归甲的 _未认领：不拿它盖掉甲原来的", async () => {
    const s = await 跑(["甲登录", "写一笔", "重启", "退出登录"]);
    const 未认领 = 账号.账号目录(根, 账号.未认领);
    fs.mkdirSync(未认领, { recursive: true });
    fs.writeFileSync(path.join(未认领, "crm.db"), JSON.stringify([{ 谁: 甲.id, 第几: 777 }]));
    fs.writeFileSync(path.join(未认领, ".owner"), 甲.id);
    await s.走("甲登录");
    expect(s.违规).toEqual([]);
    expect(读库(未认领).length).toBe(1); // 原地留着
  });

  it("认领时改名失败（Windows 目录被占）：留在原目录上，闸挡住，不串", async () => {
    const s = await 跑(["甲登录", "写一笔", "重启", "退出登录"]);
    // 让 乙 的目标目录是一个文件：mkdir 会抛
    const 乙目录 = 账号.账号目录(根, 账号.key(乙.id));
    fs.writeFileSync(乙目录, "不是目录");
    await s.走("乙登录");
    expect(s.机.事件.some((e) => e.startsWith("换账号失败"))).toBe(true);
    // LoginForm 拿到 {ok:false}：停在登录页报「换不了数据目录。请退出应用再打开一次」
    expect(s.机.页面).toBe("登录页");
    // 人自己点去别处 / 窗口重载：layout 的闸挡住（归属对不上 → logout?reason=switched）
    await s.机.打开窗口();
    expect(s.机.页面).toBe("挡住(switched)");
    expect(s.违规).toEqual([]);
  });
});

describe("随机顺序（固定种子）：任何时刻不串、不丢", () => {
  // 2026-10-04 起加回「吊销甲」（剩余风险 1）：改了密码、令牌被吊销的那个人也要拿得回、别人也领不走
  const 字母表: 步[] = ["甲登录", "乙登录", "丙登录", "乙登录(桥断)", "退出登录", "重启", "重启(断网)", "写一笔", "写一笔", "吊销甲", "吊销乙", "切回前台"];
  function 随机(seed: number) {
    let x = seed >>> 0;
    return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }

  async function 全跑() {
    const 串: string[] = [];
    const 丢: string[] = [];
    for (let k = 0; k < 300; k++) {
      const r = 随机(k + 1);
      const 步们 = Array.from({ length: 12 }, () => 字母表[Math.floor(r() * 字母表.length)]);
      fs.rmSync(根, { recursive: true, force: true });
      fs.mkdirSync(根, { recursive: true });
      const s = await 跑(步们);
      串.push(...s.违规.filter((v) => v.startsWith("【串数据】")));
      丢.push(...s.违规.filter((v) => v.startsWith("【丢数据】")));
      vi.unstubAllGlobals();
    }
    return { 串, 丢: 丢.sort((a, b) => a.length - b.length) };
  }

  it("300 条长 12 的随机序列（第一次装）：串数据一条都没有", async () => {
    expect((await 全跑()).串).toEqual([]);
  }, 120_000);

  it("【A-1 真坏】同一批序列：丢数据（给出最短反例）", async () => {
    const { 丢 } = await 全跑();
    expect(丢.slice(0, 1)).toEqual([]);
  }, 120_000);

  /*
    2026-10-04 加（A-2 / B-1 / B-2 / C-7）：从「0.39.2 之前升级上来、老 .cloud.json 没有 accountId」起步，
    字母表里加上网慢开机、断网退出、.owner 被清空。头一步轮流是断网 / 网慢 / 联网但老令牌已被吊销开机——
    前两种是 A-2 的入口，第三种是剩余风险 1（壳按 401 清掉老令牌，只剩库里管理员的邮箱能认人）。
    「吊销甲」也在字母表里：待认的老令牌、甲后来的令牌随时可能作废。
  */
  it("300 条长 12 的随机序列（升级上来、断网 / 网慢开机）：不串、不丢", async () => {
    const 升级字母表: 步[] = ["甲登录", "乙登录", "丙登录", "乙登录(桥断)", "退出登录", "退出登录(断网)", "重启", "重启(断网)", "重启(网慢)", "写一笔", "写一笔", "吊销甲", "吊销乙", "切回前台", "清空.owner"];
    const 串: string[] = [];
    const 丢: string[] = [];
    for (let k = 0; k < 300; k++) {
      const r = 随机(10_000 + k);
      const 步们 = Array.from({ length: 12 }, () => 升级字母表[Math.floor(r() * 升级字母表.length)]);
      fs.rmSync(根, { recursive: true, force: true });
      const d = path.join(根, "data");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "crm.db"), JSON.stringify([{ 谁: 甲.id, 第几: 0 }]));
      fs.writeFileSync(path.join(d, ".cloud.json"), JSON.stringify({ baseUrl: "http://cloud.test", token: "t-old-jia", name: "甲", contact: 甲.target, models: [] }));
      写管理员邮箱(d, 甲.target);
      const s = new 场景(根);
      s.云.令牌.set("t-old-jia", 甲.id);
      s.写过[甲.id] = [0];
      if (k % 3 === 0) s.云.在线 = false;
      else if (k % 3 === 1) s.云.慢 = true;
      else s.云.吊销全部(甲.id);
      await s.开机();
      s.云.在线 = true;
      s.云.慢 = false;
      for (const x of 步们) await s.走(x);
      串.push(...s.违规.filter((v) => v.startsWith("【串数据】")));
      丢.push(...s.违规.filter((v) => v.startsWith("【丢数据】")));
      vi.unstubAllGlobals();
    }
    expect(串).toEqual([]);
    expect(丢.sort((a, b) => a.length - b.length).slice(0, 1)).toEqual([]);
  }, 120_000);
});
