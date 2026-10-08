"use client";
import type { BusinessConfig } from "@/lib/business-config";
import { fmtDate } from "@/lib/utils";
import type { 客户条件 } from "./query";
import { 开始完整导出, 读取完整导出批次, 校验完整导出 } from "./export-action";
import type { 导出指令 } from "./export-protocol";

export async function 完整导出(条件: 客户条件, b: BusinessConfig, 进度: (text: string) => void, signal: AbortSignal) {
  const worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
  let workerError: Error | null = null;
  worker.onerror = () => { workerError = new Error("生成导出文件失败，请重试"); };
  async function 等待<T>(promise: Promise<T>): Promise<T> {
    检查取消();
    let cancel: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("已取消导出"));
        signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => reject(new Error("导出等待超时，请重试")), 120_000);
      })]);
    } finally { signal.removeEventListener("abort", cancel); clearTimeout(timer); }
  }
  function 检查取消() { if (signal.aborted) throw new Error("已取消导出"); }
  const 发 = (指令: 导出指令) => new Promise<Uint8Array | undefined>((resolve, reject) => {
    检查取消();
    if (workerError) return reject(workerError);
    const timer = setTimeout(() => { cleanup(); reject(new Error("生成文件超时，请重试")); }, 120_000);
    const cleanup = () => { clearTimeout(timer); worker.onmessage = null; worker.onerror = () => { workerError = new Error("生成导出文件失败，请重试"); }; signal.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reject(new Error("已取消导出")); };
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = (e) => { cleanup(); if (e.data.ok) resolve(e.data.bytes); else reject(new Error(e.data.error)); };
    worker.onerror = () => { workerError = new Error("生成导出文件失败，请重试"); cleanup(); reject(workerError); };
    try { worker.postMessage(指令); } catch (error) { cleanup(); reject(error); }
  });
  try {
    检查取消();
    进度("正在核对导出范围…");
    const 起点 = await 等待(开始完整导出(条件));
    const 指纹: { 类别: "客户" | "跟进"; 指纹: string }[] = [];
    const 数量 = { 客户: 0, 跟进: 0 };
    for (const 类别 of ["客户", "跟进"] as const) {
      let 游标: string | undefined;
      do {
        检查取消();
        const 批次 = await 等待(读取完整导出批次(条件, 起点.截止, 类别, 游标));
        检查取消();
        指纹.push({ 类别, 指纹: 批次.指纹 });
        数量[类别] += 批次.rows.length;
        进度(`正在导出${类别}：${数量[类别]} / ${类别 === "客户" ? 起点.客户数 : 起点.跟进数}`);
        if (批次.rows.length) await 发({ 动作: "分批", 批次, b });
        游标 = 批次.游标 ?? undefined;
      } while (游标);
    }
    if (数量.客户 !== 起点.客户数 || 数量.跟进 !== 起点.跟进数) throw new Error("导出期间数据发生变化，请重新导出");
    检查取消();
    进度("正在复核完整性…");
    await 等待(校验完整导出(条件, 起点, 指纹));
    检查取消();
    进度("正在生成下载包…");
    const bytes = await 发({ 动作: "完成", 清单: { ...起点, 筛选: 条件, 完成: new Date().toISOString() } });
    检查取消();
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${b.customer}完整导出-${fmtDate(new Date())}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return 数量;
  } finally { worker.terminate(); }
}
