/**
 * 导入能往哪几个字段里填，以及「表头叫什么算这个字段」。
 *
 * 只做客户这一张表。线索 / 联系人 / 渠道不做——等有人真的要。
 *
 * **为什么字段这么少。** 客户表上能写的字段远不止这些，这里刻意只开人手上那份
 * Excel 里真会有的几列。多开一列的代价不是多写几行代码，是多一种
 * 「一份表悄悄改掉了库里已有的东西」的路子。两条特意没开的：
 *
 *   - **销售负责人**：单人场景下归属就是导入的人本人（2026-09-18 拍板），
 *     不问、也不从表里读。多人团队真要按列分派，等有人提。
 *   - **推荐人**：推荐链决定归属，而归属是固化的
 *     （「谁的数据没动，谁的归属就不变」）。一份表不该静默改写它。
 *     来源渠道**只在新建那条路上生效**，见 plan.ts 的 补空字段名单。
 */
import { FOLLOW_STATUSES, DECISION_STATUSES } from "../constants";

export type 字段名 =
  | "name"
  | "phone"
  | "school"
  | "grade"
  | "major"
  | "followStatus"
  | "decisionStatus"
  | "expectedSignAt"
  | "remark"
  | "channelName";

export type 字段规格 = {
  名: 字段名;
  /** 界面上叫什么。school/grade/major 跟着业务配置走 */
  label: string;
  kind: "text" | "enum" | "date" | "name";
  /** kind=enum 时的合法值 */
  values?: readonly string[];
  /** 这一列不填会怎样 */
  必填?: true;
  /** 表头长什么样算命中这一列（全部小写、去掉空格和标点后比对） */
  别名: readonly string[];
};

/**
 * 表头的同义词表。
 *
 * 匹配前会把表头规整一遍（`规整表头`）：去空格、去全半角标点、转小写。
 * 所以这里不用把「手机 号」「手机号：」这类变体都列出来。
 *
 * **宁可猜不到，不要猜错。** 猜不到的那一列在界面上是空的下拉，人一眼看见；
 * 猜错的那一列人多半直接点了下一步，于是电话进了备注栏。所以这张表只收
 * 「几乎不可能是别的意思」的说法，不做模糊匹配、不做编辑距离。
 */
export function 字段表(b: { fields: { school: string; grade: string; major: string }; grades: string[]; customer: string }): 字段规格[] {
  return [
    { 名: "name", label: "姓名", kind: "text", 必填: true, 别名: ["姓名", "名字", "客户姓名", "客户名称", "客户", b.customer, "学员", "学员姓名", "name", "fullname", "联系人", "联系人姓名"] },
    { 名: "phone", label: "手机号", kind: "text", 必填: true, 别名: ["手机号", "手机", "电话", "联系电话", "联系方式", "手机号码", "电话号码", "mobile", "phone", "tel", "telephone"] },
    { 名: "school", label: b.fields.school, kind: "text", 别名: [b.fields.school, "院校", "学校", "公司", "单位", "公司名称", "school", "company", "org"] },
    { 名: "grade", label: b.fields.grade, kind: "enum", values: b.grades, 别名: [b.fields.grade, "年级", "职位", "职务", "岗位", "grade", "title", "position"] },
    { 名: "major", label: b.fields.major, kind: "text", 别名: [b.fields.major, "专业", "行业", "所属行业", "major", "industry"] },
    { 名: "followStatus", label: "跟进状态", kind: "enum", values: FOLLOW_STATUSES, 别名: ["跟进状态", "状态", "跟进情况", "followstatus", "status"] },
    { 名: "decisionStatus", label: "决策状态", kind: "enum", values: DECISION_STATUSES, 别名: ["决策状态", "意向", "意向度", "决策阶段", "decisionstatus"] },
    { 名: "expectedSignAt", label: "预计签约", kind: "date", 别名: ["预计签约", "预计签约时间", "预计成交", "预计签约日期", "expectedsign", "expectedsignat"] },
    { 名: "remark", label: "备注", kind: "text", 别名: ["备注", "说明", "描述", "note", "notes", "remark", "comment"] },
    { 名: "channelName", label: "来源渠道", kind: "name", 别名: ["来源渠道", "渠道", "来源", "获客渠道", "渠道名称", "channel", "source"] },
  ];
}

/**
 * 表头规整：全角转半角、去空白、**去掉括号里的整段**、去常见标点，转小写。
 *
 * 真实的 Excel 表头长这样：「手机号 」「联系电话：」「姓名(必填)」「手机号*」「Ｎａｍｅ」。
 * 不规整就得把每种写法都列进同义词表，那张表会越列越长而且永远漏。
 *
 * **括号里的整段要连内容一起去掉**，不能只去掉那对括号：
 * 「姓名(必填)」只去括号会变成「姓名必填」，同义词表里没有这一条，于是猜不到——
 * 而「必填」恰恰是最常见的那种注脚。
 */
export function 规整表头(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[(\uFF08\[\u3010][^)\uFF09\]\u3011]*[)\uFF09\]\u3011]/g, "")
    .replace(/[\s\u3000]/g, "")
    .replace(/[\uFF1A:()\uFF08\uFF09\u3010\u3011\[\]*\uFF0A\u3001,\uFF0C\u3002.\-_/\\|"'`]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * 自动猜每一列是什么字段。
 *
 * 猜不到就是 null，界面上留一个空下拉让人自己选。
 * **同一个字段被两列同时命中时，只认第一列**——「姓名」和「客户姓名」并排出现是常事，
 * 两列都往 name 里填的结果是后一列覆盖前一列，静悄悄的。
 */
export function 猜列(表头: readonly string[], 表: 字段规格[]): (字段名 | null)[] {
  const 索引 = new Map<string, 字段名>();
  for (const f of 表) {
    for (const a of f.别名) {
      const k = 规整表头(a);
      // 先登记的赢：字段表里排在前面的字段优先，同一个别名不会被后面的字段抢走
      if (k && !索引.has(k)) 索引.set(k, f.名);
    }
  }
  const 用掉 = new Set<字段名>();
  return 表头.map((h) => {
    const hit = 索引.get(规整表头(h));
    if (!hit || 用掉.has(hit)) return null;
    用掉.add(hit);
    return hit;
  });
}

/**
 * 第一行看着像表头吗。
 *
 * 有一类表压根没有表头，第一行就是第一个人。照 `成表` 的规矩，
 * 那一行会被当成表头吃掉——**第一个客户就这么没了，而且一个字的报错都没有**。
 * 这是「表和我们对不上」里最安静的一种。
 *
 * 判据只有一条，但很硬：**表头那一行里不该有电话号码。**
 * 「手机号」是三个汉字，`13800001111` 是十一位数字，没有哪一种表头长成后者。
 * 反过来说，一行里出现了像号码的格子，它就是数据行。
 * 不用「对上了几个字段」来判：英文表头、自定义叫法的表一个都对不上，
 * 但它们确确实实是表头。
 */
export function 像表头(第一行: readonly string[]): boolean {
  return !第一行.some((c) => /^\+?\d[\d\s\-()]{5,}$/.test(c.trim()));
}
