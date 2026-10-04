/**
 * 团队同步的本机这一半（2026-10-03，0.46.15 第 5 块）：变更日志、触发器、改身份、导出、回放合并。
 * 设计和每一条规矩的来由：~/CRM/团队同步探针-2026-10-03.md。
 *
 *   - 下划线表和触发器都在运行时建（迁移不许 INSERT；测试按 schema 重建库），只在开了团队的库上装
 *   - 时钟在触发器里、改动那一刻编：max(墙钟, 本机时钟 + 1)，收到别人的改动把本机时钟推到对方的数
 *     （推送时才编号的话，「先改后同步」的改动会排到已经看到的别人改动后面——探针验出来的）
 *   - 字段级后写为准；删除留墓碑；删了又被别人更晚地改 → 带整行复活
 *   - 回放时 _sync_state.applying = 1，触发器不记（防回声）
 *   - 派生字段（最近跟进）不同步，回放后对动过的客户本机重算
 *   - 同名渠道：两边都留 id 小的那个，别名记在 _sync_alias，回放时引用改过去
 *
 * 只给 Prisma 用裸 SQL：这些表不在 schema.prisma 里（不想让它们出现在托管版、自部署的库上）。
 */
import type { PrismaClient, Prisma } from "@/generated/prisma";
import { 同步表, 不同步列, 同步的设置, 指向人的列, 同名合并, 模板占位账号 } from "./tables";

type Db = PrismaClient | Prisma.TransactionClient;

/** 一条改动，推给别人的样子（加密前） */
export type 改动 = { t: string; k: string; o: "I" | "U" | "D"; r: Record<string, unknown> | null; c: string[]; h: string };

const 墙钟 = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const 数 = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
const 引 = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** 毫秒时间戳超过 32 位：列声明成 BIGINT，Prisma 的裸查询才按 BigInt 读，不然报「放不进 INT」 */
export async function 建同步表(db: Db) {
  for (const sql of [
    "CREATE TABLE IF NOT EXISTS _sync_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, op TEXT NOT NULL, row TEXT, changed TEXT NOT NULL, at BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), applying INTEGER NOT NULL DEFAULT 0)",
    "INSERT OR IGNORE INTO _sync_state (id, applying) VALUES (1, 0)",
    "CREATE TABLE IF NOT EXISTS _sync_clock (id INTEGER PRIMARY KEY CHECK (id = 1), l BIGINT NOT NULL DEFAULT 0)",
    "INSERT OR IGNORE INTO _sync_clock (id, l) VALUES (1, 0)",
    "CREATE TABLE IF NOT EXISTS _sync_field (tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL, hlc TEXT NOT NULL, PRIMARY KEY (tbl, pk, col))",
    "CREATE TABLE IF NOT EXISTS _sync_tomb (tbl TEXT NOT NULL, pk TEXT NOT NULL, hlc TEXT NOT NULL, PRIMARY KEY (tbl, pk))",
    "CREATE TABLE IF NOT EXISTS _sync_cursor (k TEXT PRIMARY KEY, v BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _sync_alias (tbl TEXT NOT NULL, fromId TEXT NOT NULL, toId TEXT NOT NULL, PRIMARY KEY (tbl, fromId))",
    // 回放时放不进来的那几条（父行已经被删的孤儿、撞唯一约束的）：记下来、跳过，不让一条坏的卡死整个队列（复查）
    "CREATE TABLE IF NOT EXISTS _sync_skip (tbl TEXT NOT NULL, pk TEXT NOT NULL, hlc TEXT NOT NULL, why TEXT NOT NULL, at BIGINT NOT NULL)",
    // 「回放中」只在回放事务里置 1，事务回滚就回到 0；这里再兜一次底：万一哪次停在 1，触发器会从此不记任何改动
    "UPDATE _sync_state SET applying = 0 WHERE id = 1",
  ]) {
    await db.$executeRawUnsafe(sql);
  }
}

async function 列们(db: Db, t: string): Promise<{ name: string; pk: number }[]> {
  const rows = await db.$queryRawUnsafe<{ name: string; pk: bigint | number }[]>(`PRAGMA table_info(${引(t)})`);
  return rows.map((r) => ({ name: r.name, pk: 数(r.pk) }));
}

async function 主键(db: Db, t: string): Promise<string> {
  const pk = (await 列们(db, t)).find((c) => c.pk === 1);
  if (!pk) throw new Error(`${t} 没有单列主键，不能同步`);
  return pk.name;
}

/** 这张表要记的列（去掉不同步的） */
async function 记的列(db: Db, t: string): Promise<string[]> {
  return (await 列们(db, t)).map((c) => c.name).filter((c) => !(不同步列[t] ?? []).includes(c));
}

/**
 * 装触发器。每次启动都重装一遍：迁移加了列之后，老触发器里写死的列名就不全了。
 * Setting 只记业务配置那几个 key。
 */
export async function 装触发器(db: Db) {
  await 卸触发器(db);
  const 编号 = `MAX(${墙钟}, (SELECT l + 1 FROM _sync_clock WHERE id = 1))`;
  const 推钟 = "UPDATE _sync_clock SET l = (SELECT MAX(at) FROM _sync_log) WHERE id = 1;";
  const 没在回放 = "(SELECT applying FROM _sync_state WHERE id = 1) = 0";
  for (const t of 同步表) {
    const cs = await 记的列(db, t);
    const pk = await 主键(db, t);
    const 行 = (p: string) => `json_object(${cs.map((c) => `'${c}', ${p}.${引(c)}`).join(", ")})`;
    const 变了 = cs.map((c) => `CASE WHEN OLD.${引(c)} IS NOT NEW.${引(c)} THEN '${c},' ELSE '' END`).join(" || ");
    const 只设置 = (p: string) => (t === "Setting" ? ` AND ${p}.${引(pk)} IN (${同步的设置.map((k) => `'${k}'`).join(", ")})` : "");
    await db.$executeRawUnsafe(`CREATE TRIGGER "_s_${t}_i" AFTER INSERT ON ${引(t)} WHEN ${没在回放}${只设置("NEW")} BEGIN
      INSERT INTO _sync_log (tbl, pk, op, row, changed, at) VALUES ('${t}', NEW.${引(pk)}, 'I', ${行("NEW")}, '*', ${编号});
      ${推钟}
    END`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "_s_${t}_u" AFTER UPDATE ON ${引(t)} WHEN ${没在回放}${只设置("NEW")} AND (${变了}) <> '' BEGIN
      INSERT INTO _sync_log (tbl, pk, op, row, changed, at) VALUES ('${t}', NEW.${引(pk)}, 'U', ${行("NEW")}, ${变了}, ${编号});
      ${推钟}
    END`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "_s_${t}_d" AFTER DELETE ON ${引(t)} WHEN ${没在回放}${只设置("OLD")} BEGIN
      INSERT INTO _sync_log (tbl, pk, op, row, changed, at) VALUES ('${t}', OLD.${引(pk)}, 'D', NULL, '', ${编号});
      ${推钟}
    END`);
  }
}

export async function 卸触发器(db: Db) {
  for (const t of 同步表) for (const s of ["i", "u", "d"]) await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "_s_${t}_${s}"`);
}

/** 本机已有的数据整份记成「新建」：第一次进团队时推上去，和别人的合并 */
export async function 记全量(db: Db, 选项: { 不含设置?: boolean } = {}) {
  for (const t of 同步表) {
    /*
      加入别人团队的那台不推业务配置：两边的全量时钟都是 1，谁的 business 赢只看设备编号大小，
      加入的人新号上的默认模版、币种有一半可能盖掉建团队的人那份（复查）。团队的配置以建团队的人为准
    */
    if (t === "Setting" && 选项.不含设置) continue;
    const cs = await 记的列(db, t);
    const pk = await 主键(db, t);
    const 过滤 = t === "Setting" ? ` WHERE ${引(pk)} IN (${同步的设置.map((k) => `'${k}'`).join(", ")})` : "";
    await db.$executeRawUnsafe(
      `INSERT INTO _sync_log (tbl, pk, op, row, changed, at)
       SELECT '${t}', ${引(pk)}, 'I', json_object(${cs.map((c) => `'${c}', ${引(c)}`).join(", ")}), '*', (SELECT l + 1 FROM _sync_clock WHERE id = 1) FROM ${引(t)}${过滤}`,
    );
    await db.$executeRawUnsafe("UPDATE _sync_clock SET l = MAX(l, COALESCE((SELECT MAX(at) FROM _sync_log), 0)) WHERE id = 1");
  }
}

/**
 * 进团队前改身份（探针场景 ①）：模板里的管理员每台都是同一个 id，换成按云端账号算的；
 * 没被用过的模板占位账号（张三、李四）删掉，用过的换成随机 id——它们在每台电脑上也是同一个 id。
 * **必须在装触发器之前做**：装了之后改主键会被记成一条「改了 id」，别人对不上。
 */
export async function 改身份(db: PrismaClient, 新id: string, 资料: { email: string; name: string }) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
    const 管理员 = await tx.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (管理员 && 管理员.id !== 新id) await 换id(tx, 管理员.id, 新id);
    await tx.user.update({ where: { id: 新id }, data: { email: 资料.email, name: 资料.name } }).catch(() => undefined);
    for (const email of 模板占位账号) {
      const u = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (!u) continue;
      let 用过 = false;
      for (const [t, c] of 指向人的列) {
        const n = await tx.$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT COUNT(*) AS n FROM ${引(t)} WHERE ${引(c)} = ?`, u.id).catch(() => [{ n: 0 }]);
        if (数(n[0]?.n) > 0) { 用过 = true; break; }
      }
      if (!用过) await tx.user.delete({ where: { id: u.id } });
      else {
        const 新 = `u_${Math.random().toString(36).slice(2, 12)}`;
        await 换id(tx, u.id, 新);
        await tx.user.update({ where: { id: 新 }, data: { email: `${email}.${新}` } });
      }
    }
  });
}

async function 换id(tx: Prisma.TransactionClient, 旧: string, 新: string) {
  await tx.$executeRawUnsafe('UPDATE "User" SET id = ? WHERE id = ?', 新, 旧);
  for (const [t, c] of 指向人的列) {
    await tx.$executeRawUnsafe(`UPDATE ${引(t)} SET ${引(c)} = ? WHERE ${引(c)} = ?`, 新, 旧).catch(() => undefined);
  }
}

const 钟串 = (at: number, 设备: string) => `${String(at).padStart(15, "0")}-${设备}`;

/**
 * 给本机还没编过字段钟的改动记字段钟（别人更早的改动不能盖掉我更晚的），并把它们排成要推的改动。
 * 不动「已推」游标：推成功了调 记已推()。
 */
export async function 待推(db: Db, 设备: string, 最多 = 2000): Promise<{ 改动: 改动[]; 到: number }> {
  const 已推 = 数((await db.$queryRawUnsafe<{ v: bigint }[]>("SELECT v FROM _sync_cursor WHERE k = 'pushed'"))[0]?.v);
  await 记本机字段钟(db, 设备);
  const rows = await db.$queryRawUnsafe<{ seq: bigint; tbl: string; pk: string; op: string; row: string | null; changed: string; at: bigint }[]>(
    "SELECT * FROM _sync_log WHERE seq > ? ORDER BY seq LIMIT ?", 已推, 最多,
  );
  return {
    改动: rows.map((r) => {
      const row = r.row ? (JSON.parse(r.row) as Record<string, unknown>) : null;
      return { t: r.tbl, k: r.pk, o: r.op as 改动["o"], r: row, c: r.changed === "*" ? Object.keys(row ?? {}) : r.changed.split(",").filter(Boolean), h: 钟串(数(r.at), 设备) };
    }),
    到: rows.length ? 数(rows[rows.length - 1].seq) : 已推,
  };
}

export async function 记已推(db: Db, 到: number) {
  await db.$executeRawUnsafe("INSERT INTO _sync_cursor (k, v) VALUES ('pushed', ?) ON CONFLICT(k) DO UPDATE SET v = MAX(v, excluded.v)", 到);
}

async function 记本机字段钟(db: Db, 设备: string) {
  const 已 = 数((await db.$queryRawUnsafe<{ v: bigint }[]>("SELECT v FROM _sync_cursor WHERE k = 'clocked'"))[0]?.v);
  const rows = await db.$queryRawUnsafe<{ seq: bigint; tbl: string; pk: string; op: string; row: string | null; changed: string; at: bigint }[]>("SELECT * FROM _sync_log WHERE seq > ? ORDER BY seq", 已);
  for (const r of rows) {
    const h = 钟串(数(r.at), 设备);
    const cols = r.changed === "*" ? Object.keys(r.row ? JSON.parse(r.row) : {}) : r.changed.split(",").filter(Boolean);
    for (const c of cols) await db.$executeRawUnsafe("INSERT INTO _sync_field (tbl, pk, col, hlc) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET hlc = MAX(hlc, excluded.hlc)", r.tbl, r.pk, c, h);
    if (r.op === "D") await db.$executeRawUnsafe("INSERT INTO _sync_tomb (tbl, pk, hlc) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET hlc = MAX(hlc, excluded.hlc)", r.tbl, r.pk, h);
  }
  if (rows.length) await db.$executeRawUnsafe("INSERT INTO _sync_cursor (k, v) VALUES ('clocked', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", 数(rows[rows.length - 1].seq));
}

/**
 * 回放别人的改动（已解密、可能来自好几台）。按时钟顺序；本机自己发出去又被拉回来的跳过。
 * 返回：应用了几条、撞了几次同名、跳过了几条（孤儿 / 撞唯一约束，记在 _sync_skip）。
 *
 * **一条坏的不许卡死整个队列**（复查）：原来一条出错整批回滚，拉取位置不前进，这台电脑从此每一轮都卡在这一批。
 *   - 每条一个保存点：撞了唯一约束只退这一条、记下跳过
 *   - 外键是延后检查的（同一批里先子后父也放得进），提交前用 foreign_key_check 找出孤儿：
 *     父行在本机已经删了（甲删客户、乙同时给他记了跟进）——能空的那一列置空，不能空的整行删掉、记下跳过
 */
export async function 回放(db: PrismaClient, 批: 改动[], 本机设备: string): Promise<{ 应用: number; 撞: number; 跳: number }> {
  const 排好 = [...批].filter((e) => !e.h.endsWith(`-${本机设备}`)).sort((a, b) => a.h.localeCompare(b.h));
  if (!排好.length) return { 应用: 0, 撞: 0, 跳: 0 };
  let 撞 = 0;
  let 跳 = 0;
  const 动过的客户 = new Set<string>();
  // 先把本机还没编字段钟的改动编上：不然别人更早的改动会盖掉我刚改、还没推的
  await 记本机字段钟(db, 本机设备);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("UPDATE _sync_state SET applying = 1 WHERE id = 1");
    await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
    const 记跳过 = async (t: string, k: string, h: string, why: string) => {
      跳++;
      await tx.$executeRawUnsafe(`INSERT INTO _sync_skip (tbl, pk, hlc, why, at) VALUES (?, ?, ?, ?, ${墙钟})`, t, k, h, why.slice(0, 300));
    };
    const 主键们 = new Map<string, string>();
    const 主 = async (t: string) => 主键们.get(t) ?? (主键们.set(t, await 主键(tx, t)), 主键们.get(t)!);
    const 列表们 = new Map<string, Set<string>>();
    const 本机列们 = async (t: string) => 列表们.get(t) ?? (列表们.set(t, new Set((await 列们(tx, t)).map((c) => c.name))), 列表们.get(t)!);
    const 别名到 = async (表: string, id: unknown) =>
      typeof id === "string" ? ((await tx.$queryRawUnsafe<{ toId: string }[]>("SELECT toId FROM _sync_alias WHERE tbl = ? AND fromId = ?", 表, id))[0]?.toId ?? id) : id;

    async function 放一条(e: 改动) {
      await tx.$executeRawUnsafe("UPDATE _sync_clock SET l = MAX(l, ?) WHERE id = 1", Number(e.h.split("-")[0]));
      const pk = await 主(e.t);
      const k = (await 别名到(e.t, e.k)) as string;
      if (e.o === "D") {
        // 删跟进 / 签约：「最近跟进」要重算，得在删之前记下是哪位客户（远端的删除不带整行）
        if (e.t === "FollowUp" || e.t === "Contract") {
          const 谁 = (await tx.$queryRawUnsafe<{ customerId: string }[]>(`SELECT customerId FROM ${引(e.t)} WHERE ${引(pk)} = ?`, k))[0]?.customerId;
          if (谁) 动过的客户.add(谁);
        }
        const 更晚 = await tx.$queryRawUnsafe<unknown[]>("SELECT 1 FROM _sync_field WHERE tbl = ? AND pk = ? AND hlc > ? LIMIT 1", e.t, k, e.h);
        if (!更晚.length) await tx.$executeRawUnsafe(`DELETE FROM ${引(e.t)} WHERE ${引(pk)} = ?`, k);
        await tx.$executeRawUnsafe("INSERT INTO _sync_tomb (tbl, pk, hlc) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET hlc = MAX(hlc, excluded.hlc)", e.t, k, e.h);
        return;
      }
      const 墓 = (await tx.$queryRawUnsafe<{ hlc: string }[]>("SELECT hlc FROM _sync_tomb WHERE tbl = ? AND pk = ?", e.t, k))[0]?.hlc;
      if (墓 && 墓 > e.h) return;
      const row = { ...(e.r ?? {}) };
      // 引用了被合并掉的那一方（同名渠道）：换成留下的那个
      for (const [表, 定义] of Object.entries(同名合并)) for (const [t, c] of 定义.被指) if (t === e.t && row[c] != null) row[c] = await 别名到(表, row[c]);
      // 本机的表比对方的少了某一列（版本不同）：只写本机有的列
      const 本机列 = await 本机列们(e.t);
      const cols = Object.keys(row).filter((c) => 本机列.has(c) && !(不同步列[e.t] ?? []).includes(c));
      const 在 = (await tx.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM ${引(e.t)} WHERE ${引(pk)} = ?`, k)).length > 0;
      if (!在) {
        // 同事的账号同步进来：密码不同步，又是 NOT NULL——放一个永远对不上的占位（谁也不能在这台电脑上用它登录）
        const 插列 = e.t === "User" && 本机列.has("password") ? [...cols, "password"] : cols;
        if (e.t === "User") row.password = "!team-sync";
        await tx.$executeRawUnsafe("SAVEPOINT s_ins");
        try {
          await tx.$executeRawUnsafe(`INSERT INTO ${引(e.t)} (${插列.map(引).join(", ")}) VALUES (${插列.map(() => "?").join(", ")})`, ...插列.map((c) => 值(row[c])));
          await tx.$executeRawUnsafe("RELEASE s_ins");
        } catch (err) {
          await tx.$executeRawUnsafe("ROLLBACK TO s_ins");
          await tx.$executeRawUnsafe("RELEASE s_ins");
          const 规 = 同名合并[e.t];
          if (!规 || !/UNIQUE/i.test(String((err as Error).message))) throw err;
          撞++;
          await 合并同名(tx, e.t, 规, row, cols);
        }
        for (const c of cols) await 记字段钟(tx, e.t, k, c, e.h);
      } else {
        const 要改: string[] = [];
        for (const c of e.c.filter((c) => cols.includes(c))) {
          const h = (await tx.$queryRawUnsafe<{ hlc: string }[]>("SELECT hlc FROM _sync_field WHERE tbl = ? AND pk = ? AND col = ?", e.t, k, c))[0]?.hlc;
          if (!h || h < e.h) 要改.push(c);
        }
        if (要改.length) await tx.$executeRawUnsafe(`UPDATE ${引(e.t)} SET ${要改.map((c) => `${引(c)} = ?`).join(", ")} WHERE ${引(pk)} = ?`, ...要改.map((c) => 值(row[c])), k);
        for (const c of 要改) await 记字段钟(tx, e.t, k, c, e.h);
      }
      if (e.t === "Customer") 动过的客户.add(k);
      if ((e.t === "FollowUp" || e.t === "Contract") && typeof row.customerId === "string") 动过的客户.add(row.customerId);
    }

    for (const e of 排好) {
      if (!(同步表 as readonly string[]).includes(e.t)) continue; // 对方版本新、多了一张我这还没有的表：跳过
      await tx.$executeRawUnsafe("SAVEPOINT s1");
      try {
        await 放一条(e);
        await tx.$executeRawUnsafe("RELEASE s1");
      } catch (err) {
        await tx.$executeRawUnsafe("ROLLBACK TO s1");
        await tx.$executeRawUnsafe("RELEASE s1");
        await 记跳过(e.t, e.k, e.h, String((err as Error)?.message ?? err));
      }
    }
    await 清孤儿(tx, 记跳过);
    await tx.$executeRawUnsafe("UPDATE _sync_state SET applying = 0 WHERE id = 1");
  }, { timeout: 180_000, maxWait: 20_000 }); // 新人第一次拉一个大团队，一批 2000 条要好几秒，默认 5 秒会超时、每轮重试都失败（复查）
  await 重算派生(db, [...动过的客户]);
  return { 应用: 排好.length - 跳, 撞, 跳 };
}

/**
 * 提交前找孤儿（外键延后检查，提交那一刻才会报，报了就整批回滚）。父行在本机已经不在：
 * 那一列能空就置空（客户的来源渠道被删了，客户照留），不能空就整行删掉（跟进挂的客户被删了）。
 * 删一行可能带出新的孤儿，循环到干净为止。
 */
async function 清孤儿(tx: Prisma.TransactionClient, 记跳过: (t: string, k: string, h: string, why: string) => Promise<void>) {
  for (let 轮 = 0; 轮 < 10; 轮++) {
    const 坏 = await tx.$queryRawUnsafe<{ table: string; rowid: bigint | number | null; parent: string; fkid: bigint | number }[]>("PRAGMA foreign_key_check");
    if (!坏.length) return;
    for (const b of 坏) {
      if (b.rowid == null) continue;
      const fk = (await tx.$queryRawUnsafe<{ id: bigint | number; from: string }[]>(`PRAGMA foreign_key_list(${引(b.table)})`)).find((f) => 数(f.id) === 数(b.fkid));
      const 列信息 = (await tx.$queryRawUnsafe<{ name: string; notnull: bigint | number; pk: bigint | number }[]>(`PRAGMA table_info(${引(b.table)})`));
      const pk = 列信息.find((c) => 数(c.pk) === 1)?.name ?? "rowid";
      const k = String((await tx.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${引(pk)} AS k FROM ${引(b.table)} WHERE rowid = ?`, 数(b.rowid)))[0]?.k ?? "");
      const 能空 = fk && 列信息.find((c) => c.name === fk.from)?.notnull != null && 数(列信息.find((c) => c.name === fk.from)!.notnull) === 0;
      if (fk && 能空) {
        await tx.$executeRawUnsafe(`UPDATE ${引(b.table)} SET ${引(fk.from)} = NULL WHERE rowid = ?`, 数(b.rowid));
      } else {
        await tx.$executeRawUnsafe(`DELETE FROM ${引(b.table)} WHERE rowid = ?`, 数(b.rowid));
        await 记跳过(b.table, k, "", `孤儿：${b.parent} 在本机已经删了`);
      }
    }
  }
}

const 值 = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

async function 记字段钟(tx: Db, t: string, k: string, c: string, h: string) {
  await tx.$executeRawUnsafe("INSERT INTO _sync_field (tbl, pk, col, hlc) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET hlc = MAX(hlc, excluded.hlc)", t, k, c, h);
}

/** 同名合并：留 id 小的。对方的小 → 本机那个让位（引用改过去、删掉）；本机的小 → 记个别名，对方那个的引用进来时换掉 */
async function 合并同名(tx: Prisma.TransactionClient, t: string, 规: { 列: string; 被指: [string, string][] }, row: Record<string, unknown>, cols: string[]) {
  const 本 = (await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM ${引(t)} WHERE ${引(规.列)} = ?`, row[规.列]))[0];
  const 远 = String(row.id);
  if (!本) throw new Error(`${t} 撞了唯一约束，但找不到本机同名的那一行`);
  if (远 < 本.id) {
    await tx.$executeRawUnsafe(`UPDATE ${引(t)} SET ${引(规.列)} = ${引(规.列)} || '#合并中' WHERE id = ?`, 本.id);
    await tx.$executeRawUnsafe(`INSERT INTO ${引(t)} (${cols.map(引).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => 值(row[c])));
    for (const [pt, pc] of 规.被指) await tx.$executeRawUnsafe(`UPDATE ${引(pt)} SET ${引(pc)} = ? WHERE ${引(pc)} = ?`, 远, 本.id);
    await tx.$executeRawUnsafe(`DELETE FROM ${引(t)} WHERE id = ?`, 本.id);
    await tx.$executeRawUnsafe("INSERT OR REPLACE INTO _sync_alias (tbl, fromId, toId) VALUES (?, ?, ?)", t, 本.id, 远);
  } else {
    await tx.$executeRawUnsafe("INSERT OR REPLACE INTO _sync_alias (tbl, fromId, toId) VALUES (?, ?, ?)", t, 远, 本.id);
  }
}

/**
 * 派生字段本机重算：最近跟进 = 跟进记录里最晚那条（和 saveFollowUp 里同一个算法）。重算本身不进日志——
 * 不用「回放中」开关：lastFollowAt 不在触发器记的列里，裸 UPDATE 也不动 updatedAt，触发器本来就不响。
 * 原来在事务外把开关置 1：重算那一会儿用户另一个请求里的保存不进日志，中途退出应用开关还停在 1（复查）
 */
async function 重算派生(db: PrismaClient, 客户们: string[]) {
  for (const id of 客户们) {
    await db.$executeRawUnsafe('UPDATE "Customer" SET lastFollowAt = (SELECT MAX(occurredAt) FROM "FollowUp" WHERE customerId = ?) WHERE id = ?', id, id);
  }
}

/** 开着团队吗（本机库里有没有装触发器） */
export async function 装了吗(db: Db): Promise<boolean> {
  const r = await db.$queryRawUnsafe<unknown[]>("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = '_s_Customer_i'");
  return r.length > 0;
}

/**
 * 业务员离开团队：这台电脑只留他自己的（2026-10-04 两档权限）。
 * 同步要求每台都有全队的数据，业务员只是界面上看不到同事的；人一走，界面上的限定也就没了（一个人用 = 看全部）。
 * 所以走的时候把不归他的客户（连同跟进、商机、签约、联系人，级联删）、别人的线索和操作日志从这台删掉，
 * 同步日志里存着的整行副本也清掉。**必须在卸了触发器之后做**：这些删除不能当成改动推出去。
 */
export async function 只留自己的(db: PrismaClient, 我: string) {
  const 我的客户 = (await db.customer.findMany({ where: { OR: [{ salesOwnerId: 我 }, { channelOwnerId: 我 }] }, select: { id: true } })).map((c) => c.id);
  await db.$transaction(async (tx) => {
    await tx.customer.deleteMany({ where: { id: { notIn: 我的客户 } } });
    await tx.lead.deleteMany({ where: { OR: [{ ownerId: null }, { ownerId: { not: 我 } }], customerId: null } });
    await tx.auditLog.deleteMany({ where: { userId: { not: 我 } } });
    await tx.unassignedContact.deleteMany({ where: { OR: [{ fromCustomerId: null }, { fromCustomerId: { notIn: 我的客户 } }] } });
  });
  for (const t of ["_sync_log", "_sync_field", "_sync_tomb", "_sync_skip", "_sync_cursor", "_sync_alias"]) {
    await db.$executeRawUnsafe(`DELETE FROM ${t}`).catch(() => undefined);
  }
}
