import type { BusinessConfig } from "@/lib/business-config";
import type { 读取完整导出批次, 开始完整导出 } from "./export-action";
export type 导出批次 = Awaited<ReturnType<typeof 读取完整导出批次>>;
export type 导出起点 = Awaited<ReturnType<typeof 开始完整导出>>;
export type 导出指令 = { 动作: "分批"; 批次: 导出批次; b: BusinessConfig } | { 动作: "完成"; 清单: 导出起点 & { 筛选: unknown; 完成: string } };
