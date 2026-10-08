import { strToU8, zipSync } from "fflate";
import { 写xlsx } from "@/lib/xlsx-write";
import { 客户导出表, 跟进导出表 } from "./export-table";
import type { 导出指令 } from "./export-protocol";

// 每次导出独占一个Worker，失败/取消会销毁，不会把半份结果下载给用户。
const files: Record<string, Uint8Array> = {};
const parts: { 文件: string; 类别: string; 条数: number; 首条ID: string; 尾条ID: string }[] = [];
self.onmessage = (event: MessageEvent<导出指令>) => {
  try {
    const task = event.data;
    if (task.动作 === "分批") {
      const { 批次, b } = task;
      const table = 批次.类别 === "客户" ? 客户导出表(批次.rows, b) : 跟进导出表(批次.rows, b);
      // 编号是核对关系的稳定键，同名/同电话不会混在一起；放最后保持导入识别习惯。
      const ids = 批次.rows.map((r) => "customerId" in r ? [r.customerId, r.id] : [r.id]);
      const name = `${批次.类别}-${String(parts.filter((p) => p.类别 === 批次.类别).length + 1).padStart(3, "0")}.xlsx`;
      files[name] = 写xlsx([{ 名: 批次.类别 === "客户" ? b.customer : "跟进记录", 表头: [...table.head, "客户编号", ...(批次.类别 === "跟进" ? ["跟进编号"] : [])], 行: table.body.map((r, i) => [...r, ...ids[i]]) }]);
      parts.push({ 文件: name, 类别: 批次.类别, 条数: 批次.rows.length, 首条ID: 批次.rows[0]?.id ?? "", 尾条ID: 批次.rows.at(-1)?.id ?? "" });
      self.postMessage({ ok: true });
    } else {
      files["导出清单.json"] = strToU8(JSON.stringify({ ...task.清单, 分批: parts }, null, 2));
      files["阅读说明.txt"] = strToU8("客户与跟进分别分批保存；按客户编号关联，按清单逐份核对条数。客户表可再导入，再导入时将客户编号列设为不导入；跟进表供查阅。文件仅包含当前账号可见且符合筛选条件的数据。导出逐批读取并在下载前复核，不含开始导出后新增的记录。正在编辑时请暂停修改再导出。\n");
      // 内层xlsx已压缩；外层只打包，避免再次重复压缩。
      const zip = zipSync(files, { level: 0 });
      self.postMessage({ ok: true, bytes: zip }, { transfer: [zip.buffer] });
    }
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : "生成导出文件失败" });
  }
};
