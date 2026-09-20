/**
 * 猜列兜底的合并规则。
 *
 * 这里一条都不打真接口——打接口的那几条在 tests/jev/ 里，单独跑（要 key、要网、要花钱）。
 * 这一份钉的是**错了不会报错、只会静悄悄出事**的那几条：
 *   规则命中的列被模型改掉 / 两列都填同一个字段 / 低置信的猜测被当真 / 模型编出一个我们没有的字段。
 * 四条里任何一条破了，表现都是「导进去的数据错了一列」，而界面上什么都不会说。
 */
import { describe, it, expect } from "vitest";
import { 字段表, 猜列, type 字段名 } from "@/lib/import/fields";
import { 组问题, 并进来, 弃权, 置信阈值, 样例行数 } from "@/lib/jev/columns";

const b = {
  fields: { school: "院校", grade: "年级", major: "专业" },
  grades: ["大一", "大二", "大三", "大四"],
  customer: "客户",
};
const 表 = 字段表(b);
const 答 = (选: string, 置信 = 0.9) => ({ 选, 置信 });

describe("组问题：只问规则答不上来的", () => {
  it("规则全认出来了就一个问题都不问——不发这次请求", () => {
    const 表头 = ["姓名", "手机号"];
    const 规则 = 猜列(表头, 表);
    expect(规则).toEqual(["name", "phone"]);
    expect(Object.keys(组问题(表头, [], 规则, 表))).toHaveLength(0);
  });

  it("只给弃权的那几列组问题，键按列下标", () => {
    const 表头 = ["姓名", "毕业院校", "手机号", "从哪来的"];
    const 规则 = 猜列(表头, 表);
    const q = 组问题(表头, [["张三", "北大", "13800000000", "小红书"]], 规则, 表);
    expect(Object.keys(q).sort()).toEqual(["c1", "c3"]);
  });

  it("样例只取前三行，空格子写成「（空）」而不是消失", () => {
    const 数据 = [["甲"], ["乙"], ["丙"], ["丁"]];
    // 只看题面：选项说明里各字段名天然带各种字符，拿它做「不包含」的断言会误伤
    const 题面 = (组问题(["怪表头"], 数据, [null], 表).c0.instructions as string);
    expect(题面).toContain("甲");
    expect(题面).toContain("丙");
    expect(题面).not.toContain("丁");
    expect(样例行数).toBe(3);

    const 空的 = (组问题(["怪表头"], [[""], [""], [""]], [null], 表).c0.instructions as string);
    expect(空的).toContain("（空）");
  });

  it("别名不重复——label 本身常常就在别名表里", () => {
    const 说明 = JSON.stringify(组问题(["x"], [], [null], 表).c0);
    expect(说明).not.toContain("院校、院校");
    expect(说明).not.toContain("客户、客户");
  });

  it("选项说明跟着业务配置走，不是手抄的第二份字典", () => {
    const 外贸 = 字段表({ fields: { school: "公司", grade: "职位", major: "行业" }, grades: ["总监"], customer: "客户" });
    const 文 = JSON.stringify(组问题(["x"], [], [null], 外贸).c0);
    expect(文).toContain("公司");
    expect(文).toContain("职位");
  });
});

describe("并进来：规则赢，人赢，模型垫底", () => {
  it("规则命中的列，模型改不动", () => {
    const 规则: (字段名 | null)[] = ["name", null];
    const 出 = 并进来(规则, { c0: 答("remark"), c1: 答("phone") }, 表);
    expect(出).toEqual(["name", "phone"]);
  });

  it("同一个字段只认第一列——Jev 并行回答，它不知道别的列答了什么", () => {
    // 「联系方式」和「TEL」实测都会被判成 phone
    const 出 = 并进来([null, null], { c0: 答("phone"), c1: 答("phone") }, 表);
    expect(出).toEqual(["phone", null]);
  });

  it("规则已经占掉的字段，模型也抢不走", () => {
    const 出 = 并进来(["phone", null], { c1: 答("phone") }, 表);
    expect(出).toEqual(["phone", null]);
  });

  it("弃权就是留空", () => {
    expect(并进来([null], { c0: 答(弃权, 0.99) }, 表)).toEqual([null]);
  });

  it("置信不够就留空，让人自己选", () => {
    expect(并进来([null], { c0: 答("name", 置信阈值 - 0.01) }, 表)).toEqual([null]);
    expect(并进来([null], { c0: 答("name", 置信阈值) }, 表)).toEqual(["name"]);
  });

  it("模型编了一个我们没有的字段，丢掉——否则界面上是个空下拉，谁都不知道为什么", () => {
    expect(并进来([null], { c0: 答("idCardNumber") }, 表)).toEqual([null]);
  });

  it("没拿到答案（断网 / 没配 key / 超时）就原样返回规则的结果", () => {
    const 规则: (字段名 | null)[] = ["name", null, "phone"];
    expect(并进来(规则, null, 表)).toEqual(规则);
  });

  it("答案里缺了某一列也不影响其余列", () => {
    expect(并进来([null, null], { c1: 答("phone") }, 表)).toEqual([null, "phone"]);
  });
});
