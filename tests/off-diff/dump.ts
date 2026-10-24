/**
 * 把整个库倒成一份能逐字段比的 JSON（差分测试用，见 scenario.test.ts）。
 *
 * 两次跑出来的 id（cuid）、库自己填的时间（Prisma 用真实时钟，不吃假时间）、密码哈希（随机盐）天生不一样，
 * 这里只把这三样换成稳定的写法，别的一个字不动：
 *   - id 按「表名#插入顺序」重新编号，出现在任何地方（外键、JSON、操作记录的文字）都换
 *   - 早于 2029 年的时间 = 库自己填的真实时间，写成 <db-now>（场景的假时间从 2030 年开始）
 *   - User.password 写成 <hash>
 */
import { prisma } from "@/lib/prisma";

type 行 = Record<string, unknown>;
export type 库 = Record<string, 行[]>;

/** 场景的假时间都在这之后；早于它的时间都是库用真实时钟填的 */
const 假时间起点 = Date.UTC(2029, 0, 1);

export async function 倒库(): Promise<{ 表: 库; 列: Record<string, string[]> }> {
  const 表名们 = (await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name`,
  )).map((r) => r.name);
  const 表: 库 = {};
  const 列: Record<string, string[]> = {};
  for (const t of 表名们) {
    列[t] = (await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${t}")`)).map((c) => c.name);
    表[t] = await prisma.$queryRawUnsafe<行[]>(`SELECT * FROM "${t}" ORDER BY rowid`);
  }
  return { 表, 列 };
}

/** id → 「表#序号」。只认叫 id 的那一列（联合主键的表没有自己的 id，靠外键被换掉） */
function 编号(表: 库): Map<string, string> {
  const m = new Map<string, string>();
  for (const [t, 行们] of Object.entries(表)) {
    行们.forEach((r, i) => {
      if (typeof r.id === "string" && r.id.length >= 8 && !m.has(r.id)) m.set(r.id, `${t}#${i + 1}`);
    });
  }
  return m;
}

function 像时间(v: unknown): number | null {
  if (typeof v === "number" || typeof v === "bigint") {
    const n = Number(v);
    return n > 1e12 && n < 1e13 ? n : null;
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) {
    const n = Date.parse(v.includes("T") || v.endsWith("Z") ? v : v.replace(" ", "T") + "Z");
    return Number.isNaN(n) ? null : n;
  }
  if (v instanceof Date) return v.getTime();
  return null;
}

/** 整份（库 + 每一步的返回）一起规整，id 编号表从库里来 */
export function 规整<T>(表: 库, 其它: T): { 表: 库; 其它: T } {
  const m = 编号(表);
  const 们 = [...m.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const 认 = 们.length ? new RegExp(们.join("|"), "g") : null;
  const 换字 = (s: string) => (认 ? s.replace(认, (x) => m.get(x) ?? x) : s);
  const 值 = (v: unknown, 键?: string): unknown => {
    if (v === null || v === undefined) return v ?? null;
    if (键 === "password" && typeof v === "string") return "<hash>";
    const 时 = 像时间(v);
    if (时 !== null) return 时 < 假时间起点 ? "<db-now>" : new Date(时).toISOString();
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "string") return 换字(v);
    if (Array.isArray(v)) return v.map((x) => 值(x));
    if (typeof v === "object") return Object.fromEntries(Object.entries(v as 行).map(([k, x]) => [k, 值(x, k)]));
    return v;
  };
  const 新表: 库 = {};
  for (const [t, 行们] of Object.entries(表)) {
    新表[t] = 行们.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, 值(x, k)])));
  }
  return { 表: 新表, 其它: 值(其它) as T };
}
