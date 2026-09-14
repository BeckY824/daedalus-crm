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

  it("三块面板都在，注册和找回的入口也在", () => {
    const p = 页面();
    for (const id of ["p-login", "p-reg", "p-reset"]) expect(p).toContain(`id="${id}"`);
    // 这两个入口原来是没有的：人得先去网页上注册、去网页上改密码，再回来登录
    expect(p).toContain("注册新账号");
    expect(p).toContain("忘记密码？");
  });

  it("页面里没有漏掉的模板插值", () => {
    /**
     * 整段页面本身就在一个模板字符串里。里面再写 ${...} 会被外层吃掉，
     * 写 `...` 会提前结束字符串——两种都不会报错，只会拼出一段坏 HTML。
     * 云端地址那一处是**故意**插进去的，除它以外不该再有第二处。
     */
    const p = 页面();
    const 插值 = [...p.matchAll(/\$\{[^}]*\}/g)].map((m) => m[0]);
    expect(插值).toEqual(["${JSON.stringify(云)}"]);
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
