/**
 * 二维表 + 列映射 → 每一行打算写什么、哪一格有问题。
 *
 * 纯函数，不碰数据库。查重、渠道解析、真正落库在 import-actions.ts 里。
 *
 * **一条贯穿全文件的分寸：逐格留空，不整行拒绝。**
 * 一行里有一个日期格式看不懂，不该让这个人整条进不来——把那一格留空、标出来，
 * 其余字段照进。整行拒绝的代价是人要回 Excel 里改完再导一遍，
 * 而他多半根本不知道是哪一格的事。
 *
 * 只有两种情况整行进不了，都和「认人」有关：没有手机号、手机号不像个号码。
 * 手机号是这套库里认人的唯一依据（schema 里 Customer.phone 的注释就是「查重主键」），
 * 没有它这一行既不知道是谁、也没法判断是不是已经有了。
 */
import type { 字段名, 字段规格 } from "./fields";

export type 严重程度 = "拦行" | "留空" | "用默认";

export type 格问题 = {
  /** 第几列（从 0 数，对应表头数组的下标） */
  列: number;
  字段: 字段名;
  原值: string;
  /** 给人看的一句话 */
  说法: string;
  严重: 严重程度;
};

export type 一行 = {
  /** 在原表里的行号，1 是表头，所以第一条数据是 2——报错时人要照着这个数去 Excel 里找 */
  行号: number;
  值: Partial<Record<字段名, string>>;
  问题: 格问题[];
  /** 有值 = 这一行整条进不了，这句话就是原因 */
  进不了?: string;
};

/**
 * 手机号规整：只留数字，去掉国家码和分隔符。
 *
 * 为什么非规整不可：这是认人的那一列。Excel 里同一个号码有十种写法
 * （`138 0000 1111`、`138-0000-1111`、`+86 13800001111`、被存成文本的 `'13800001111'`），
 * 不规整的话同一个人会被当成十个人，而查重是**精确比对**——
 * 一个空格就足以让「跳过重复」这件事整个失效，且毫无迹象。
 */
export function 规整手机号(v: string): string {
  let s = v.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
  s = s.replace(/^'/, "");
  s = s.replace(/[\s\-()（）.]/g, "");
  s = s.replace(/^\+?0*86(?=\d{11}$)/, "");
  return s;
}

/**
 * 看着像个号码吗。
 *
 * **故意比表单那条 `/^1[3-9]\d{9}$/` 松。** 表单管的是人一个一个录进来的新客户，
 * 严一点是帮他；导入面对的是人手上已经存在的那份表，里面真有座机、真有带分机号的、
 * 真有海外号码。用大陆手机号的正则去卡它，等于告诉人「你表里这三十个客户不合法」——
 * 而他们明明是他的客户。
 *
 * 只挡两种：根本没有数字（把姓名列当成手机号列对错了），和长得离谱。
 */
export function 像手机号(s: string): boolean {
  const 数字 = s.replace(/\D/g, "");
  return 数字.length >= 6 && 数字.length <= 20;
}

/**
 * Excel 的日期有三种面孔，都要认：
 *   1. 文本：`2026-09-19`、`2026/9/19`、`2026年9月19日`
 *   2. 序列号：`46000`（1900 年 1 月 0 日起的天数，Excel 自己的存法）
 *   3. 浏览器里解析 xlsx 时已经变成的 ISO 串
 *
 * 认不出来返回 null，由调用方把那一格留空并标出来——**绝不猜**。
 * 猜错一个预计签约日期，人会照着它去安排下周的工作。
 */
export function 认日期(v: string): Date | null {
  const s = v.trim();
  if (!s) return null;
  // Excel 序列号。25569 = 1970-01-01；小于它的当不是日期（那更可能是个数量）
  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n < 25569 || n > 80000) return null;
    const ms = Math.round((n - 25569) * 86400 * 1000);
    const u = new Date(ms);
    if (isNaN(u.getTime())) return null;
    /*
      **落成本地时间的零点，不是 UTC 零点。**

      序列号算出来的是 UTC 时刻，而下面文本那条路走的是 `new Date(y, m, d)`，
      落的是本地零点。两条路不统一的话，同一个「2026-09-19」经由 xlsx 和经由 csv
      进来会差几个小时——在 UTC 以西的时区里就直接差一天，界面上显示成前一天，
      而两边都没有任何报错。日期只用来看「哪一天」，时分秒没有意义。
    */
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
  }
  const 规整 = s
    .replace(/[年月]/g, "-")
    .replace(/日/g, "")
    .replace(/\./g, "-")
    .replace(/\//g, "-")
    .replace(/-+$/, "");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(规整);
  if (m) {
    const [, y, mo, d] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    // 2026-02-31 会被 Date 滚到 3 月 3 日。滚过头就说明这个日期不存在
    if (dt.getMonth() !== Number(mo) - 1 || dt.getDate() !== Number(d)) return null;
    return dt;
  }
  return null;
}

/**
 * 枚举值对齐：完全相等最好，其次去掉空白再比。
 *
 * **不做近似匹配。** 「已联系」和「已加微信」编辑距离很近，但意思差得远，
 * 而跟进状态是拿来筛人、排工作的。对不上就用默认值 + 标出来，让人在复核那一步
 * 自己指一下——那一步里同一个写法改一次，整列一起生效，不比猜慢。
 */
export function 认枚举(v: string, values: readonly string[]): string | null {
  const s = v.trim();
  if (!s) return null;
  const hit = values.find((x) => x === s);
  if (hit) return hit;
  const 紧 = s.replace(/[\s　]/g, "");
  return values.find((x) => x.replace(/[\s　]/g, "") === 紧) ?? null;
}

export type 排布 = {
  表头: string[];
  数据: string[][];
  /** 每一列对到哪个字段，null = 这列不导 */
  映射: (字段名 | null)[];
  字段表: 字段规格[];
  /**
   * 对不上任何字段的那几列怎么办。
   *
   * 这是导入里最常见的一种落差：人手上那份表有「微信号」「身份证」「客户等级」
   * 「年营收」这些我们没有的列。自定义字段是明确不做的（那是另一个产品），
   * 于是只有两条路：**丢掉**，或者**并进备注**。
   *
   * 默认是并进备注，因为丢掉是不可见的损失——人以为整份表都进来了，
   * 几周后才发现微信号一个都没有，而那时原表可能已经改过了。
   * 并进备注至少让那些字还在这个人身上，能搜得到。
   */
  没对上的列?: "并进备注" | "丢掉";
  /**
   * 人在复核那一步改过的值：`列|原值` → 改成什么。
   * 键里带列号，因为同一个词在不同列里的意思不同
   * （「其他」在年级列和在跟进状态列是两个值）。
   */
  改过?: Record<string, string>;
};

/** 复核那一步的修改键。导出出来是为了界面和这里用的是同一把钥匙，别各拼各的 */
export function 改动键(列: number, 原值: string): string {
  return `${列}|${原值}`;
}

/**
 * 把整张表摊成一行一行的结果。
 *
 * 这是导入的心脏：预览上那四个数、复核那一屏列的问题、真正落库时写什么，
 * 全部从这一个函数的结果里读。**不许有第二处算同样的东西**——
 * 预览说「新建 30 条」而实际建了 28 条，这种事只会发生在两处各算一遍的时候。
 */
export function 摊开(p: 排布): 一行[] {
  const 规格 = new Map(p.字段表.map((f) => [f.名, f]));
  return p.数据.map((r, i) => {
    const 行号 = i + 2;
    const 值: Partial<Record<字段名, string>> = {};
    const 问题: 格问题[] = [];

    p.映射.forEach((字段, 列) => {
      if (!字段) return;
      const f = 规格.get(字段);
      if (!f) return;
      const 原值 = (r[列] ?? "").trim();
      const 改成 = p.改过?.[改动键(列, 原值)];
      const v = 改成 !== undefined ? 改成 : 原值;
      if (!v) return;

      if (字段 === "phone") {
        const n = 规整手机号(v);
        if (!像手机号(n)) {
          问题.push({ 列, 字段, 原值: v, 说法: "这不像一个电话号码", 严重: "拦行" });
          return;
        }
        值.phone = n;
        return;
      }
      if (f.kind === "enum") {
        const hit = 认枚举(v, f.values ?? []);
        if (!hit) {
          问题.push({ 列, 字段, 原值: v, 说法: `「${v}」不是${f.label}里的值，这一格会用默认值`, 严重: "用默认" });
          return;
        }
        值[字段] = hit;
        return;
      }
      if (f.kind === "date") {
        const d = 认日期(v);
        if (!d) {
          问题.push({ 列, 字段, 原值: v, 说法: `「${v}」读不出是哪一天，这一格会留空`, 严重: "留空" });
          return;
        }
        值[字段] = d.toISOString();
        return;
      }
      // text 和 name：原样收下。name 那一类（来源渠道）要对到库里的记录，
      // 对不上在落库那一步才知道——这里没有数据库
      值[字段] = v;
    });

    /*
      对不上任何字段的那几列：默认并进备注，写成「表头：值」一行一条。

      **不做自定义字段**（那是另一个产品，ROADMAP 里明确不做），
      但也不能默不作声地丢掉——人以为整份表都进来了，几周后才发现
      微信号一个都没有，而那时原表可能已经改过了。
      并进备注至少让那些字还在这个人身上，搜得到。
    */
    if ((p.没对上的列 ?? "并进备注") === "并进备注") {
      const 捡回来: string[] = [];
      p.映射.forEach((字段, 列) => {
        if (字段) return;
        const 头 = (p.表头[列] ?? "").trim();
        const v = (r[列] ?? "").trim();
        // 没有表头的列并进去只会是一串没有出处的值，那比丢掉还糟
        if (!头 || !v) return;
        捡回来.push(`${头}：${v}`);
      });
      if (捡回来.length > 0) {
        值.remark = 值.remark ? `${值.remark}\n${捡回来.join("\n")}` : 捡回来.join("\n");
      }
    }

    // 认人那两格。顺序要紧：先说没有手机号，再说姓名——手机号是认人的那一列
    let 进不了: string | undefined;
    if (!值.phone) {
      const 有格问题 = 问题.some((q) => q.字段 === "phone");
      进不了 = 有格问题 ? "手机号看不出是个号码" : "这一行没有手机号";
    } else if (!值.name) {
      进不了 = "这一行没有姓名";
    }
    return { 行号, 值, 问题, ...(进不了 ? { 进不了 } : {}) };
  });
}

/**
 * 同一份表里手机号重复的行：后面的补前面的空，合成一条。
 *
 * Attio 那边把这件事写在预览里叫「最多创建 X 条」——真正执行时同一唯一值的多行会合并。
 * 我们直接在预览之前就合掉，预览上那个数就是真实会发生的数：
 * **人看到的数和事后的结果不一致，比数大一点更伤信任。**
 *
 * 合并方向是「先来的赢」：第一次出现的那行是主，后面几行只填它没填的格。
 * 反过来（后来的覆盖）意味着表格末尾一个残缺的补录行能抹掉前面完整的那条。
 */
export function 并重复行(rows: 一行[]): { 行: 一行[]; 合掉几行: number } {
  const 按号: Map<string, 一行> = new Map();
  const 出: 一行[] = [];
  let 合掉几行 = 0;
  for (const r of rows) {
    if (r.进不了 || !r.值.phone) {
      出.push(r);
      continue;
    }
    const 已有 = 按号.get(r.值.phone);
    if (!已有) {
      按号.set(r.值.phone, r);
      出.push(r);
      continue;
    }
    for (const [k, v] of Object.entries(r.值)) {
      if (v && !已有.值[k as 字段名]) 已有.值[k as 字段名] = v;
    }
    已有.问题.push(...r.问题);
    合掉几行++;
  }
  return { 行: 出.filter((r) => r.进不了 || 按号.get(r.值.phone ?? "") === r), 合掉几行 };
}
