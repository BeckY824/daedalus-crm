import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { 企业版 } from "@/lib/enterprise/switch";
import { 当前是共享区 } from "@/lib/shared-ws/current";
import { 读文件们, type 读出的表 } from "@/lib/enterprise-import/excel";
import { 试跑 } from "@/lib/enterprise-import/report";
import { 已认映射, 读同步设置 } from "@/lib/enterprise-import/sync";
import { 实体顺序, type 实体 } from "@/lib/enterprise-import/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 企业版导入 · Excel 兜底：飞书 / 钉钉导出的文件传上来，试跑出报告（不写数据，人看过再正式导入）。
 *   POST multipart/form-data：files = 一个或几个 .xlsx / .csv；实体.<文件名> = customer|contact|…（可选，人指定这个文件是哪一类）
 *   一个 xlsx 里几张表的，每张叫「文件名·表名」，也可以按 实体.<文件名·表名> 单独指定
 *   → { 批次Id, 报告 }
 * 走 API 不走 server action：server action 默认只收 1 MB。
 * 以前从 Excel 正式导入过的，照那次人认过的映射来，新冒出来的列才问 AI。
 */

const 不存 = { "Cache-Control": "no-store" };
/** 一次上传几个文件加起来的上限：单个文件的上限在 读文件 里（和大批导入同一套） */
const 一次上限字节 = 200 * 1024 * 1024;
const 一次最多文件 = 10;

export async function POST(req: Request) {
  if (!企业版()) return NextResponse.json({ error: "企业版没开" }, { status: 404 });
  const 我 = await getCurrentUser();
  if (!我) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (我.role !== "ADMIN" || (await 当前是共享区())) return NextResponse.json({ error: "只有管理员能做企业版导入" }, { status: 403 });

  const 切了 = (await 读同步设置("excel")).切换;
  if (切了) return NextResponse.json({ error: `Excel 导入已经在 ${切了.时间.slice(0, 10)} 切换过了，不再收新文件` }, { status: 400 });

  const 长 = Number(req.headers.get("content-length") ?? 0);
  if (长 > 一次上限字节) return NextResponse.json({ error: `一次传的文件加起来超过 ${一次上限字节 / 1024 / 1024} MB，请分几次传` }, { status: 413 });

  let 表单: FormData;
  try {
    表单 = await req.formData();
  } catch {
    return NextResponse.json({ error: "没收到文件，请重新选一下" }, { status: 400 });
  }
  const 文件们 = 表单.getAll("files").filter((f): f is File => typeof f !== "string");
  if (!文件们.length) return NextResponse.json({ error: "没收到文件，请重新选一下" }, { status: 400 });
  if (文件们.length > 一次最多文件) return NextResponse.json({ error: `一次最多传 ${一次最多文件} 个文件` }, { status: 400 });
  // 报告上「这个文件是哪一类」按文件名改，同名的分不开
  if (new Set(文件们.map((f) => f.name)).size < 文件们.length) return NextResponse.json({ error: "有两个文件同名，请改个名再传" }, { status: 400 });
  if (文件们.reduce((s, f) => s + f.size, 0) > 一次上限字节) {
    return NextResponse.json({ error: `一次传的文件加起来超过 ${一次上限字节 / 1024 / 1024} MB，请分几次传` }, { status: 413 });
  }

  const 指定实体 = (v: FormDataEntryValue | null) => (typeof v === "string" && (实体顺序 as string[]).includes(v) ? (v as 实体) : null);
  try {
    const 表们: 读出的表[] = [];
    for (const f of 文件们) {
      if (!/\.(xlsx|csv)$/i.test(f.name)) throw new Error(`${f.name}：只收 .xlsx 或 .csv（.xls 请在 Excel 里另存为 .xlsx）`);
      for (const t of 读文件们({ 名: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })) {
        const 实 = 指定实体(表单.get(`实体.${t.名}`));
        if (实) t.实体 = 实;
        表们.push(t);
      }
    }
    const r = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 表们, 已有映射: await 已认映射("excel") });
    return NextResponse.json(r, { headers: 不存 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
