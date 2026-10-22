/**
 * 桌面端「用系统程序打开附件」（desktop/attachments.js，2026-10-22 D-24）。
 * 钉的是：编号挡 ../；拷到临时目录用原名打开；能跑的文件只在文件夹里选中；文件不在说清楚。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require_ = createRequire(import.meta.url);
const 附件 = require_("../desktop/attachments.js");

let 根: string;
let 数据目录: string;
let 临时根: string;
beforeEach(() => {
  根 = fs.mkdtempSync(path.join(os.tmpdir(), "desk-att-"));
  数据目录 = path.join(根, "data");
  临时根 = path.join(根, "tmp");
  fs.mkdirSync(path.join(数据目录, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(数据目录, "attachments", "cabc12345678"), "PDF 内容");
});
afterEach(() => fs.rmSync(根, { recursive: true, force: true }));

const 假壳 = () => ({ openPath: vi.fn(async (_p: string) => ""), showItemInFolder: vi.fn((_p: string) => undefined) });

describe("打开附件", () => {
  it("拷到临时目录、用原名交给系统", async () => {
    const shell = 假壳();
    const r = await 附件.打开附件({ 数据目录, id: "cabc12345678", 名: "报价单.pdf", shell, 临时根 });
    expect(r).toEqual({ ok: true });
    const 副本 = path.join(临时根, "cabc12345678", "报价单.pdf");
    expect(shell.openPath).toHaveBeenCalledWith(副本);
    expect(fs.readFileSync(副本, "utf8")).toBe("PDF 内容");
  });

  it("编号不对（../ 之类）一律不碰", async () => {
    const shell = 假壳();
    for (const id of ["../crm.db", "..", "a/b", "", "短"]) {
      expect((await 附件.打开附件({ 数据目录, id, 名: "x.pdf", shell, 临时根 })).ok).toBe(false);
    }
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("名字里的路径、Windows 不认的字符去掉，副本不会跑出临时目录", async () => {
    const shell = 假壳();
    await 附件.打开附件({ 数据目录, id: "cabc12345678", 名: "..\\..\\a:b?.pdf", shell, 临时根 });
    const 打开的 = shell.openPath.mock.calls[0][0] as string;
    expect(path.dirname(打开的)).toBe(path.join(临时根, "cabc12345678"));
    expect(path.basename(打开的)).toBe("a_b_.pdf");
    expect(附件.安全文件名("CON.txt")).toBe("_CON.txt");
    expect(附件.安全文件名("  ")).toBe("附件");
  });

  it("能跑的文件（.exe .bat .sh .app …）不替人打开，只在文件夹里选中", async () => {
    for (const 名 of ["装我.exe", "x.BAT", "a.sh", "b.command", "c.lnk"]) {
      const shell = 假壳();
      const r = await 附件.打开附件({ 数据目录, id: "cabc12345678", 名, shell, 临时根 });
      expect(r.只显示).toBe(true);
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).toHaveBeenCalled();
    }
  });

  it("文件不在这台电脑上 / 系统打不开：回一句人话", async () => {
    const shell = 假壳();
    expect(await 附件.打开附件({ 数据目录, id: "cnothere0000", 名: "a.pdf", shell, 临时根 })).toEqual({ ok: false, error: "文件不在这台电脑上" });
    shell.openPath.mockResolvedValueOnce("没有关联的程序");
    expect((await 附件.打开附件({ 数据目录, id: "cabc12345678", 名: "a.xyz", shell, 临时根 })).error).toContain("没有关联的程序");
  });
});

describe("壳里接上了", () => {
  it("main.js 有 attachments:open，preload 露出 desktopAttachments.open，安装包白名单里有 attachments.js", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8");
    expect(main).toContain('ipcMain.handle("attachments:open"');
    const preload = fs.readFileSync(path.resolve(__dirname, "../desktop/preload-app.js"), "utf8");
    expect(preload).toContain('exposeInMainWorld("desktopAttachments"');
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../desktop/package.json"), "utf8"));
    expect(pkg.build.files).toContain("attachments.js");
  });
});
