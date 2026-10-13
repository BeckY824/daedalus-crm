/**
 * 范围同步（CRM_SCOPED_SYNC）的「本机库里有没有越权的行」（2026-10-13）：只读打开业务员那台的 crm.db 逐行核。
 *
 * 该有什么以老板那台为准（老板收全队，是独立于中转目录的真相）：业务员只该有
 *   - 负责人 / 渠道负责人是他、或在公海里的客户，以及挂在这些客户下的一切（跟进、计划、商机、签约、订单、联系人…，
 *     按 lib/sync/scope-policy.ts 的 范围父表 一路往上找到客户）；
 *   - 全队共享的 User / Setting / Channel / Supplier；
 *   - 他本人的私人条目（待归属联系人、没挂客户的线索、对象不认得的操作日志）。
 * 不只看业务表：_sync_log / _sync_field / _sync_tomb / _sync_skip 里按（表, 编号）记着的副本、ImportRow 的撤销快照也算；
 * 再拿「不该有的客户」的电话和名字在 _sync_log 整行、AuditLog 的说明 / 明细、ImportRow.before 里全文搜一遍。
 * _sync_scope_conflict（失权前没传上去的本人改动，产品有意保留、等老板核对）不算越权。
 *
 * 只核对、不判红：返回越权条目，等不等、红不红由 run.mjs 决定。
 */
import fs from "node:fs";
import { 查库 } from "./lib.mjs";

const 全队表 = ["User", "Setting", "Channel", "Supplier"];
const 附属表 = ["_sync_log", "_sync_field", "_sync_tomb", "_sync_skip"];

const 记住 = (fn) => {
  const m = new Map();
  return (库, 表) => {
    const k = `${库}|${表}`;
    if (!m.has(k)) m.set(k, fn(库, 表));
    return m.get(k);
  };
};
// 表结构一次跑里不变（库文件路径不同就分开记）
const 有表 = 记住((库, 表) => 查库(库, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", 表).length > 0);
const 主键 = 记住((库, 表) => 查库(库, `SELECT name FROM pragma_table_info('${表}') WHERE pk = 1`)[0]?.name ?? "id");

/**
 * @param {object} o
 * @param {string} o.库 业务员那台的 crm.db
 * @param {string} o.老板库 老板那台的 crm.db（真相）
 * @param {string} o.我 这台的账号行 id（acct_…）
 * @param {Record<string, Record<string, string>>} o.父表 scope-policy 的 范围父表
 * @param {readonly string[]} o.同步表 tables.ts 的 同步表
 * @param {boolean} [o.含公海=true] 还在团队里 = 公海的也算他的；退出 / 被移出之后只算本人的
 * @param {string} [o.控制库] 云端控制库：只用来找「哪台都已经删掉了」的记录当时挂在谁下面（SyncScopedRecord 里删除的记录保留归属字段）
 * @param {string} [o.团队id]
 * @returns {{ 越权: string[], 查了: number }}
 */
export function 查越权({ 库, 老板库, 我, 父表, 同步表, 含公海 = true, 控制库, 团队id }) {
  const 老板客户 = new Map(查库(老板库, "SELECT id, name, phone, salesOwnerId, channelOwnerId FROM Customer").map((c) => [c.id, c]));
  const 公海 = new Set(含公海 ? 查库(老板库, "SELECT customerId FROM CustomerPool").map((r) => r.customerId) : []);
  const 本机客户 = new Map(查库(库, "SELECT id, salesOwnerId, channelOwnerId FROM Customer").map((c) => [c.id, c]));
  const 归他 = (c) => Boolean(c) && (c.salesOwnerId === 我 || c.channelOwnerId === 我);
  /** 老板那台还没有的（他刚录、还没传到）按本机那行算 */
  const 客户该有 = (id) => (老板客户.has(id) ? 归他(老板客户.get(id)) || 公海.has(id) : 归他(本机客户.get(id)));

  const 缓存 = new Map();
  const 取行 = (表, 编号) => {
    const k = `${表}:${编号}`;
    if (!缓存.has(k)) {
      const pk = 主键(库, 表);
      const sql = `SELECT * FROM "${表}" WHERE "${pk}" = ?`;
      缓存.set(k, 查库(库, sql, 编号)[0] ?? (有表(老板库, 表) ? 查库(老板库, sql, 编号)[0] : undefined) ?? 已删的(表, 编号) ?? null);
    }
    return 缓存.get(k);
  };
  /**
   * 哪台都已经删掉的记录（例如接手的人删了的订单）：服务端索引里删除的记录还留着归属字段，挂在它上面的操作日志仍归那位客户
   * （scope-policy 算范围 同样这样算）。只认已删除的，没删的一律以两台库为准
   */
  const 已删的 = (表, 编号) => {
    if (!控制库 || !团队id) return undefined;
    const m = 查库(控制库, "SELECT metadata FROM SyncScopedRecord WHERE teamId = ? AND key = ?", 团队id, `${表}:${编号}`)[0]?.metadata;
    const r = m ? JSON.parse(m) : null;
    return r?.deleted ? { ...r.fields } : undefined;
  };
  /** 一行归谁：{ 客户 } / { 本人 } / { 全队 }；关系链断了（父记录哪台都没有）= null */
  const 归属 = (表, 编号, 深 = 0) => {
    if (深 > 12) return null;
    if (全队表.includes(表)) return { 全队: true };
    if (表 === "Customer") return { 客户: 编号 };
    const r = 取行(表, 编号);
    if (!r) return null;
    if (表 === "UnassignedContact" || (表 === "Lead" && !r.customerId)) return { 本人: r.ownerId ?? null };
    if (表 === "AuditLog") {
      const 目标 = r.entity && r.entityId && 同步表.includes(r.entity) && 取行(r.entity, r.entityId) ? 归属(r.entity, r.entityId, 深 + 1) : null;
      return 目标 ?? { 本人: r.userId ?? null };
    }
    for (const [列, 父] of Object.entries(父表[表] ?? {})) if (r[列]) return 归属(父, r[列], 深 + 1);
    return null;
  };
  const 该有 = (g) => g && (g.全队 || (g.本人 !== undefined ? g.本人 === 我 : 客户该有(g.客户)));
  const 说 = (g) => (!g ? "找不到归属（父记录哪台都没有）" : g.客户 ? `客户 ${g.客户}（老板那台：负责人 ${老板客户.get(g.客户)?.salesOwnerId ?? "—"}${公海.has(g.客户) ? "、在公海" : ""}；${老板客户.has(g.客户) ? "" : "老板那台没有这位；"}本机：负责人 ${本机客户.get(g.客户)?.salesOwnerId ?? "—"}）` : `本人条目 ${g.本人}`);

  const 越权 = [];
  let 查了 = 0;
  for (const 表 of 同步表) {
    if (全队表.includes(表) || !有表(库, 表)) continue;
    const pk = 主键(库, 表);
    for (const { k } of 查库(库, `SELECT "${pk}" AS k FROM "${表}"`)) {
      查了++;
      const g = 归属(表, String(k));
      if (!该有(g)) 越权.push(`${表}:${k} → ${说(g)}`);
    }
  }
  // 同步日志 / 字段钟 / 墓碑里按（表, 编号）记着的副本。已经删掉的记录（哪台都没有了）对不上归属，不算
  for (const 附 of 附属表) {
    if (!有表(库, 附)) continue;
    for (const { tbl, pk } of 查库(库, `SELECT DISTINCT tbl, pk FROM "${附}"`)) {
      if (!同步表.includes(tbl) || 全队表.includes(tbl)) continue;
      查了++;
      const g = 归属(tbl, String(pk));
      if (g && !该有(g)) 越权.push(`${附}（${tbl}:${pk}）→ ${说(g)}`);
    }
  }
  if (有表(库, "ImportRow")) {
    for (const r of 查库(库, "SELECT id, customerId FROM ImportRow")) {
      查了++;
      if (!客户该有(r.customerId)) 越权.push(`ImportRow:${r.id} → ${说({ 客户: r.customerId })}`);
    }
  }
  // 全文：不该有的客户的电话 / 名字出现在整行日志、操作日志、导入快照里。名字是该有的某位名字的一部分（老客户1 ⊂ 老客户10）就只搜电话
  const 该有名字 = [...老板客户.values()].filter((c) => 客户该有(c.id)).map((c) => c.name ?? "");
  const 词 = [];
  for (const c of 老板客户.values()) {
    if (客户该有(c.id)) continue;
    if (c.phone) 词.push([c.phone, c.id]);
    if (c.name && !该有名字.some((n) => n.includes(c.name))) 词.push([c.name, c.id]);
  }
  const 文本 = [];
  if (有表(库, "_sync_log")) for (const r of 查库(库, "SELECT seq, row FROM _sync_log WHERE row IS NOT NULL")) 文本.push([`_sync_log#${r.seq}`, r.row]);
  if (有表(库, "AuditLog")) for (const r of 查库(库, "SELECT id, summary, detail FROM AuditLog")) 文本.push([`AuditLog:${r.id}`, `${r.summary ?? ""}\n${r.detail ?? ""}`]);
  if (有表(库, "ImportRow")) for (const r of 查库(库, "SELECT id, before FROM ImportRow WHERE before IS NOT NULL")) 文本.push([`ImportRow:${r.id}`, r.before]);
  for (const [哪, s] of 文本) for (const [w, id] of 词) if (s.includes(w)) 越权.push(`${哪} 里有不该有的客户 ${id} 的「${w}」`);
  return { 越权, 查了 };
}

/**
 * 文件层面：crm.db、crm.db-wal 的原始字节里还搜得到多少位「不该有的客户」的电话 / 名字（删掉的行可能还留在空闲页、页内空隙、WAL 里）。
 * 2026-10-14 起判红：清理失权副本 / 退出团队删完之后产品会整库重建（VACUUM）并把 WAL 截断（scoped-local 擦净删除残留），
 * 删掉的客户在库文件里一个字节都不该剩。名字是该有的某位名字的一部分（老客户1 ⊂ 老客户10）、或是该有的名字后面接数字（老客户1 + 电话 138… 在页里拼成「老客户11」）就只搜电话。
 * @param {{ 库: string, 老板库: string, 我: string, 含公海?: boolean }} o 含公海 = false：退出 / 被移出之后公海的也不该有
 * @returns {{ 文件: string, 命中: string[] }[]} 命中 = 客户 id
 */
export function 字节残留({ 库, 老板库, 我, 含公海 = true }) {
  const 全部 = 查库(老板库, "SELECT c.id, c.name, c.phone, c.salesOwnerId, c.channelOwnerId, (SELECT 1 FROM CustomerPool p WHERE p.customerId = c.id) AS pool FROM Customer c");
  const 该有 = (c) => c.salesOwnerId === 我 || c.channelOwnerId === 我 || (含公海 && c.pool);
  const 该有名字 = 全部.filter(该有).map((c) => c.name ?? "");
  const 词 = [];
  for (const c of 全部) {
    if (该有(c)) continue;
    if (c.phone) 词.push([c.phone, c.id]);
    // 库页里一行的各列是挨着存的：该有的「老客户1」后面紧跟电话 138…，字节里就拼出了「老客户11」——这种名字也只搜电话
    if (c.name && !该有名字.some((n) => n.includes(c.name) || (c.name.startsWith(n) && /^\d+$/.test(c.name.slice(n.length))))) 词.push([c.name, c.id]);
  }
  const out = [];
  for (const f of [库, `${库}-wal`]) {
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    out.push({ 文件: f.split("/").pop(), 命中: [...new Set(词.filter(([w]) => buf.includes(Buffer.from(w, "utf8"))).map(([, id]) => id))] });
  }
  return out;
}
