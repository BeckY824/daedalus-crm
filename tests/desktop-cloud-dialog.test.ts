/**
 * 桌面端那个云端账号窗（登录 / 注册 / 找回密码）。
 *
 * 它是一段用 data: URL 拼出来的 HTML——Electron 没有内置输入框，只能这么画。
 * 代价是**编译器完全看不见它**：把一个 id 改了名、把一条 ipc 通道改了字，
 * 谁都不会报错，只有打开那个窗口点下去才发现按钮没反应。
 * 这里就把几条跨文件的约定钉住，让改坏它的人在测试里先看到。
 *
 * 不引 jsdom：为一段静态字符串拖一个 DOM 实现进来不划算，而真正会坏的
 * 也不是 DOM 行为，是「引用的东西存不存在」。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 桌面 = path.resolve(__dirname, "../desktop");
const main = fs.readFileSync(path.join(桌面, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(桌面, "preload.js"), "utf8");

/** 从 main.js 里把那段页面原样抠出来 */
function 页面(): string {
  const 起 = main.indexOf("encodeURIComponent(`", main.indexOf("function 登录云端"));
  expect(起, "找不到云端账号窗的页面模板").toBeGreaterThan(0);
  const 头 = 起 + "encodeURIComponent(`".length;
  const 尾 = main.indexOf("</body>`)", 头);
  expect(尾, "页面模板没有正常结束").toBeGreaterThan(头);
  return main.slice(头, 尾);
}

function 去重(xs: string[]): string[] {
  return [...new Set(xs)];
}

describe("云端账号窗", () => {
  it("脚本里引到的每个 id，页面上都真有", async () => {
    const p = 页面();
    const ids = 去重([...p.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      expect(p.includes(`id="${id}"`), `脚本引用了 #${id}，但页面上没有这个元素`).toBe(true);
    }
  });

  it("两块面板都在，注册是个开浏览器的链接", () => {
    const p = 页面();
    for (const id of ["p-login", "p-reset"]) expect(p).toContain(`id="${id}"`);
    expect(p).toContain("忘记密码？");
    /**
     * 注册**不在窗口里做**。试过在应用内直接开「只有账号没有工作区」的号，
     * 结果那种账号进不了网页版，而同一个邮箱又注册不了第二次。
     * 这一条钉住那个决定：有入口，但它是把人送去网页的。
     */
    expect(p).toContain("注册新账号");
    expect(p).not.toContain('id="p-reg"');
    // 带 from=desktop：注册页据此在注册完之后说「回桌面端登录」，而不是把人丢进网页版
    expect(p).toContain("crm.open(云 + '/signup?from=desktop')");
  });

  it("页面里没有漏掉的模板插值", () => {
    /**
     * 整段页面本身就在一个模板字符串里。里面再写 ${...} 会被外层吃掉，
     * 写 `...` 会提前结束字符串——两种都不会报错，只会拼出一段坏 HTML。
     * 故意插进去的只有两类：云端地址，和「必须登录」时改文案的那几个 `必须 ? … : …`
     * （本地模式 2026-09-15 起把这个窗当门用，标题、说明、取消键的字都随之变）。除此以外不该有。
     */
    const p = 页面();
    const 插值 = [...p.matchAll(/\$\{[^}]*\}/g)].map((m) => m[0]);
    expect(插值).toContain("${JSON.stringify(云)}");
    for (const x of 插值) {
      expect(x === "${JSON.stringify(云)}" || x.startsWith("${必须 ? "), `不认识的插值：${x}`).toBe(true);
    }
    expect(插值.filter((x) => x.startsWith("${必须 ? ")).length).toBe(3);
  });

  it("preload 暴露的能力、页面用到的能力、main 处理的通道，三边对得上", () => {
    /**
     * Electron 里最典型的一类坏法：preload 改了个名字，页面照旧调，
     * 主进程照旧等着另一个通道名——三处任意两处对不上都不报错，只是点了没反应。
     */
    const p = 页面();
    const 暴露 = 去重([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
    const 用到 = 去重([...p.matchAll(/crm\.(\w+)\(/g)].map((m) => m[1]));
    for (const f of 用到) expect(暴露, `页面调了 crm.${f}()，preload 没暴露它`).toContain(f);

    const 通道 = 去重([...preload.matchAll(/ipcRenderer\.send\("([\w-]+)"/g)].map((m) => m[1]));
    const 处理 = main.slice(main.indexOf("function 登录云端"));
    for (const ch of 通道) {
      // save-url 是另一个窗口（连服务器地址）的通道，不在这个窗口里处理
      if (ch === "save-url") continue;
      expect(处理.includes(`"${ch}"`), `preload 会发 ${ch}，但云端账号窗里没有处理它`).toBe(true);
    }
  });

  it("外链只放我们自己的站点出去", () => {
    /**
     * 页面里的链接是写死的两条（用户协议、隐私政策），但 crm.open 是一个
     * 「把字符串交给系统浏览器打开」的口子。主进程那边必须自己判一次前缀——
     * 页面被改坏时，这一道是最后一层。
     */
    const 处理 = main.slice(main.indexOf("function 登录云端"));
    expect(处理).toContain('u.startsWith(云 + "/")');
  });
});

/**
 * 批 5：这个窗口要能说清五种状态。
 *
 * 它是 data: URL 拼出来的 HTML，打开它要真的起 Electron，所以这里退一步——
 * 钉住「话有没有写在里面」。写了不代表一定好用，但没写一定不好用，
 * 而这五种恰恰是最容易被漏掉的：漏了人就只能对着一个没反应的按钮猜。
 */
describe("登录窗要说清的五种状态", () => {
  const 全文 = main;

  it("邮箱 / 手机号格式不对，当场就说，不白跑一趟服务器", () => {
    const p = 页面();
    expect(p).toMatch(/像账号/);
    expect(p).toMatch(/不像邮箱/);
  });

  it("连不上服务器是一条结果，不是一个没人接的异常", () => {
    const cloud = fs.readFileSync(path.join(桌面, "cloud.js"), "utf8");
    // fetch 必须被包住：不包的话拔网线点登录，按钮一直禁用着，一个字都不出
    expect(cloud).toMatch(/try\s*\{[\s\S]{0,200}await fetch\(/);
    expect(cloud).toMatch(/连不上服务器/);
    expect(cloud).toMatch(/没回应/);
  });

  it("登录成功但本地服务没起来时，有一条说人话的提示", () => {
    expect(全文).toMatch(/本地服务没能启动|本机的 CRM 服务没能起来/);
  });

  it("登录成功要说清「这台机器记住了什么」", () => {
    expect(全文).toMatch(/设备令牌/);
    expect(页面()).toMatch(/设备令牌/);
  });

  it("也要说清退出登录会把那枚令牌吊销", () => {
    expect(全文).toMatch(/退出登录[^\n]*吊销|吊销[^\n]*令牌/);
  });

  it("颜色和字号是从应用那套 token 抄来的，不是另拍一套", () => {
    const p = 页面();
    expect(p).toMatch(/--brand:#2f6bff/);
    expect(p).toMatch(/--fs-body:14px/);
    // 抄完就得用上：正文、输入框、按钮都不该再出现裸色值
    expect(p).toMatch(/background:var\(--workbench\)/);
    expect(p).toMatch(/background:var\(--brand\)/);
  });
});
