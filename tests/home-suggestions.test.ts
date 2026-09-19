/**
 * 一个人用的时候，首页不该推团队问句。
 *
 * 「这个月谁签得最多」在单人库里答案永远是「就你自己」——点一下，烧掉当天
 * 三次免费提问里的一次（注册赠送 30 次一台电脑只发一次，之后每天补 3 次），
 * 换回一句他早就知道的话。和 0.40 之前注册页写着「送 30 次」是同一类毛病：
 * **界面上说着一句在你这儿不成立的话。**
 *
 * 这条用源码判：单人那一支到底摆了哪几句，是要钉住的东西，
 * 而「跑一遍首页看看」看不出它有没有按人数分支。
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const 页 = () => readFile("src/app/(app)/dashboard/page.tsx", "utf8");

/**
 * 三元里单人那一支的**数组本身**。
 *
 * 不能用「从 `就我一个人` 到 `for (const x of 兜底)`」整段去判：那一段里还有一整块注释，
 * 而注释里正大光明地引用着「这个月谁签得最多」——第一版就是这么把自己绊倒的。
 * 要钉的是摆出去的那几条，不是解释它们为什么这么摆的那些字。
 */
async function 单人分支() {
  const s = await 页();
  const 段 = s.slice(s.indexOf("兜底: Suggestion[] = 就我一个人"), s.indexOf("for (const x of 兜底)"));
  return 段.slice(段.indexOf("? ["), 段.indexOf(": ["));
}

describe("首页建议按人数分支", () => {
  it("用的是现成的 唯一负责人()，不另立一套判据", async () => {
    const s = await 页();
    expect(s).toContain("唯一负责人");
    // 建档、导入、商机、渠道四处早就在用它，这里是第五处，口径必须一致
    expect(s).toMatch(/就我一个人\s*=\s*\(await 唯一负责人\(\)\)\s*!==\s*null/);
  });

  it("单人那一支里没有任何团队问句", async () => {
    const 分支 = await 单人分支();
    for (const 团队味 of ["谁签得最多", "哪个销售", "团队", "排行"]) {
      expect(分支, `单人首页不该问「${团队味}」`).not.toContain(团队味);
    }
  });

  it("单人那一支问的是「我」", async () => {
    const 分支 = await 单人分支();
    expect(分支).toContain("我这周做了什么");
    expect(分支).toContain("我很久没");
    expect(分支).toContain("我手上");
  });

  it("多人那一支一个字没动——这一版只管桌面端单人", async () => {
    const s = await 页();
    expect(s).toContain("这个月哪个销售的签约金额最多");
  });

  it("「我这周做了什么」有工具接得住，不是问了也白问", async () => {
    const tools = await readFile("src/lib/agent/tools.ts", "utf8");
    expect(tools).toContain('name: "my_recap"');
  });
});
