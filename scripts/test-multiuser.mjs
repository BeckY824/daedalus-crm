/**
 * 多用户并发验收测试。
 * 启动两个独立会话的客户端实例（各自 userData，cookie 互不干扰），
 * 用 CDP 驱动真实点击与输入，验证：
 *   1. 各自能登录
 *   2. A 新建的数据 B 能看到
 *   3. B 的修改 A 能看到
 *   4. 两人同时写入互不影响、不报错
 *
 *   node scripts/test-multiuser.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { rmSync } from "node:fs";

const BASE = process.env.CRM_URL ?? "http://localhost:3000";
const APP = path.resolve("../crm-desktop");
const ELECTRON = path.join(APP, "node_modules/.bin/electron");

const stamp = process.env.STAMP ?? String(Date.now()).slice(-6);
const results = [];
const ok = (n, d = "") => { results.push({ n, pass: true, d }); console.log(`  ✅ ${n}${d ? " — " + d : ""}`); };
const bad = (n, d = "") => { results.push({ n, pass: false, d }); console.log(`  ❌ ${n}${d ? " — " + d : ""}`); };

/* ---------- CDP 会话封装 ---------- */
class Session {
  constructor(label, port, userDataDir) {
    Object.assign(this, { label, port, userDataDir });
  }

  async start() {
    rmSync(this.userDataDir, { recursive: true, force: true });
    this.proc = spawn(ELECTRON, [APP, `--user-data-dir=${this.userDataDir}`, `--remote-debugging-port=${this.port}`], {
      stdio: "ignore", detached: false,
    });
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json`);
        const list = await r.json();
        const page = list.find((t) => t.type === "page");
        if (page) { await this.connect(page.webSocketDebuggerUrl); return; }
      } catch {}
      await sleep(1000);
    }
    throw new Error(`${this.label} 启动超时`);
  }

  async connect(url) {
    this.ws = new WebSocket(url);
    this.id = 0; this.pend = new Map();
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) { this.pend.get(m.id)(m); this.pend.delete(m.id); }
    };
    await new Promise((r) => (this.ws.onopen = r));
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }

  send(method, params = {}) {
    return new Promise((res) => {
      const i = ++this.id;
      this.pend.set(i, res);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  /** 导航后旧执行上下文会失效，这里重试直到拿到新的上下文 */
  async eval(expr) {
    for (let i = 0; i < 8; i++) {
      const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r?.result?.result && !r.result.exceptionDetails) return r.result.result.value;
      await sleep(900);
    }
    return null;
  }

  /** 轮询直到条件成立 */
  async until(expr, tries = 30) {
    for (let i = 0; i < tries; i++) {
      if (await this.eval(expr)) return true;
      await sleep(1500);
    }
    return false;
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
    await sleep(3000);
    await this.until("document.readyState === 'complete'", 20);
  }

  /** 真实鼠标点击：CDP 派发的是可信事件，React 才会响应 */
  async clickAt(x, y) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    await sleep(300);
  }

  async clickText(text) {
    const box = await this.eval(`(() => {
      const el = [...document.querySelectorAll('button,a,span.ant-btn')].find(b => b.innerText.trim() === ${JSON.stringify(text)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
    })()`);
    if (!box) throw new Error(`找不到「${text}」`);
    const { x, y } = JSON.parse(box);
    await this.clickAt(x, y);
  }

  async login(user, pass) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      await this.goto(`${BASE}/login`);
      await this.eval(`(() => {
        const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
        const i=document.querySelectorAll('input'); set(i[0],${JSON.stringify(user)}); set(i[1],${JSON.stringify(pass)});
      })()`);
      await this.clickText("登 录").catch(async () => {
        const b = await this.eval(`(() => { const el=document.querySelector('button[type=submit]'); const r=el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
        const { x, y } = JSON.parse(b);
        await this.clickAt(x, y);
      });
      await sleep(4000);
      const p = await this.eval("location.pathname");
      if (p !== "/login") return true;
    }
    return false;
  }

  async stop() { try { this.ws?.close(); } catch {} this.proc?.kill(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 测试主体 ---------- */
console.log(`\n多用户验收测试  目标 ${BASE}  标记 ${stamp}\n`);

const A = new Session("A(sam)", 9401, "/tmp/crm-test-a");
const B = new Session("B(beck)", 9402, "/tmp/crm-test-b");

try {
  console.log("[1] 两个独立会话登录");
  await Promise.all([A.start(), B.start()]);
  (await A.login("sam", "Crm@2026")) ? ok("A 以 sam 登录") : bad("A 以 sam 登录");
  (await B.login("beck", "Crm@2026")) ? ok("B 以 beck 登录") : bad("B 以 beck 登录");

  const whoA = await A.eval("document.querySelector('.ant-layout-header')?.innerText.replace(/\\n+/g,' ')||''");
  const whoB = await B.eval("document.querySelector('.ant-layout-header')?.innerText.replace(/\\n+/g,' ')||''");
  whoA.includes("Sam") ? ok("A 会话身份正确", whoA.trim()) : bad("A 会话身份", whoA);
  whoB.includes("Beck") ? ok("B 会话身份正确", whoB.trim()) : bad("B 会话身份", whoB);
  (whoA !== whoB) ? ok("两个会话相互独立") : bad("两个会话相互独立", "身份相同");

  console.log("\n[2] A 新建线索，B 是否可见");
  const leadA = `A线索-${stamp}`;
  await A.goto(`${BASE}/leads`);
  const created = await createLead(A, leadA);
  created ? ok("A 创建线索成功", leadA) : bad("A 创建线索失败");

  await B.goto(`${BASE}/leads`);
  const bSees = await pageHas(B, leadA);
  bSees ? ok("B 立即看到 A 创建的数据") : bad("B 看不到 A 的数据");

  console.log("\n[3] B 新建线索，A 是否可见");
  const leadB = `B线索-${stamp}`;
  const created2 = await createLead(B, leadB);
  created2 ? ok("B 创建线索成功", leadB) : bad("B 创建线索失败");

  await A.goto(`${BASE}/leads`);
  const aSees = await pageHas(A, leadB);
  aSees ? ok("A 立即看到 B 创建的数据") : bad("A 看不到 B 的数据");
  (await pageHas(A, leadA)) ? ok("A 自己的数据未受影响") : bad("A 自己的数据丢失");

  console.log("\n[4] 两人同时写入");
  const [c1, c2] = await Promise.all([
    createLead(A, `并发A-${stamp}`),
    createLead(B, `并发B-${stamp}`),
  ]);
  (c1 && c2) ? ok("同时写入均成功") : bad("同时写入", `A=${c1} B=${c2}`);

  await A.goto(`${BASE}/leads`);
  const both = (await pageHas(A, `并发A-${stamp}`)) && (await pageHas(A, `并发B-${stamp}`));
  both ? ok("并发写入的两条数据都在") : bad("并发写入有数据丢失");

  console.log("\n[5] 页面无错误");
  const errA = await A.eval("document.body.innerText.includes('database is locked') || document.body.innerText.includes('Application error')");
  const errB = await B.eval("document.body.innerText.includes('database is locked') || document.body.innerText.includes('Application error')");
  (!errA && !errB) ? ok("两个会话均无锁冲突/报错") : bad("出现锁冲突或错误页");

} catch (e) {
  bad("测试执行异常", String(e).slice(0, 120));
} finally {
  await A.stop(); await B.stop();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${"=".repeat(46)}\n结果：${passed}/${results.length} 通过`);
results.filter((r) => !r.pass).forEach((r) => console.log(`  失败：${r.n} ${r.d}`));
process.exit(results.some((r) => !r.pass) ? 1 : 0);

/* ---------- 辅助 ---------- */
async function createLead(S, name) {
  try {
    await S.goto(`${BASE}/leads`);
    await S.until("!!document.querySelector('.ant-table')");
    await S.clickText("新建线索");
    if (!(await S.until("document.querySelectorAll('[role=dialog] input').length > 0"))) return false;
    const filled = await S.eval(`(() => {
      const m = document.querySelector('[role=dialog]');
      if (!m) return false;
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
      const first = m.querySelector('input');
      if (!first) return false;
      set(first, ${JSON.stringify(name)});
      return true;
    })()`);
    if (!filled) return false;
    await S.clickText("保 存").catch(() => S.clickText("保存"));
    return await S.until("!document.querySelector('[role=dialog]')", 20);
  } catch { return false; }
}

async function pageHas(S, text) {
  for (let i = 0; i < 3; i++) {
    const has = await S.eval(`document.body.innerText.includes(${JSON.stringify(text)})`).catch(() => false);
    if (has) return true;
    await sleep(2000);
  }
  return false;
}
