/**
 * 项目列表 / 看板的读（2026-10-23，D-31）。看板按 nodes.ts 的 看板列们 分列，
 * 每列列头写项目数和金额合计，金额按币种分开不换汇（总控 10-23 定：项目不进首页统计、数据页、业绩，只在自己的看板里合计）。
 */
import { 按币种合计, type 币种合计 } from "../currency";
import { 看板列, 看板列们, type 看板列 as 列名 } from "./nodes";

export type 项目行 = {
  id: string;
  name: string;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
  phase: string;
  node: string;
  result: string | null;
  /** 异常状态时选的类别名（类别停用了也照显示）和备注 */
  exceptionCategory: string | null;
  exceptionReason: string | null;
  /** 在项目公海里（ownerId 还是放回去的人，界面写「公海」） */
  pooled: boolean;
  amount: number;
  currency: string;
  updatedAt: string;
};

export type 看板一列 = { 列: 列名; 数: number; 合计: 币种合计[]; 行: 项目行[] };

/** 五列都在（空的也摆出来，列头写 0），列里按最近改过的排前 */
export function 看板分列(行: 项目行[]): 看板一列[] {
  return 看板列们.map((列) => {
    const 这列 = 行.filter((r) => 看板列(r) === 列).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { 列, 数: 这列.length, 合计: 按币种合计(这列, (r) => r.amount, (r) => r.currency), 行: 这列 };
  });
}
