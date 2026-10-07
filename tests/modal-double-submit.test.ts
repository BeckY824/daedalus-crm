/**
 * 弹框保存要防连点（2026-10-07）：Sam 在连着团队的 Mac 上新建商机，网慢时点了几下「保存」，建出三条一样的商机。
 * 联系人 / 计划 / 待办 / 跟进 10-02 修过一轮，商机、线索、成员、供应商、订单、比价那几个弹框漏了。
 *
 * 钉法：src 里每个 `onOk={…}` 的 Modal，同一个文件里要有 confirmLoading（或 okButtonProps 带 loading）。
 * 重复点也不会多出东西的（改名这类）列进下面的名单，写清为什么。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 不用防: Record<string, string> = {
  "src/app/(app)/dashboard/ConversationList.tsx": "只有改对话名字：点两下也是改成同一个名字，不会多出东西",
};

function 列文件(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? 列文件(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("弹框保存防连点", () => {
  it("每个 onOk 弹框都挂了 confirmLoading（或 okButtonProps 的 loading）", () => {
    const 根 = path.resolve(__dirname, "..");
    const 没防 = 列文件(path.join(根, "src"))
      // Windows 上是反斜杠：统一成正斜杠，名单才对得上（10-07 Windows 打包机上红过）
      .map((f) => path.relative(根, f).split(path.sep).join("/"))
      .filter((f) => {
        const s = fs.readFileSync(path.join(根, f), "utf8");
        return /<Modal\b/.test(s) && /\bonOk=\{/.test(s) && !/confirmLoading|okButtonProps=\{\{[^}]*loading/.test(s) && !(f in 不用防);
      });
    expect(没防, "这些弹框点「保存」时没有防连点").toEqual([]);
  });
});
