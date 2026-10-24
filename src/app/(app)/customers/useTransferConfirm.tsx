"use client";

import { App } from "antd";
import { 转走项目说法 } from "@/lib/carry-over";
import { 转走项目预览of } from "./actions";

/**
 * 换客户负责人之前先问一句（企业版 D-36，2026-10-24）：客户名下的项目会整体跟着走，
 * 转之前把「会一起转走的 N 个项目」列出来。批量分配、公海领取 / 分配、详情页改负责人、编辑客户共用。
 * 没有项目 = 不弹框直接转（和原来一样）；数不出来不拦着——转本身照样会带走项目，这里只是提前说
 */
export function useTransferConfirm() {
  const { modal } = App.useApp();

  /** true = 接着转；false = 点了取消。新负责人不传 = 转给自己（领取） */
  async function 先问转走的项目(ids: string[], 新负责人?: string): Promise<boolean> {
    if (!ids.length) return true;
    let 说法: ReturnType<typeof 转走项目说法>;
    try {
      说法 = 转走项目说法(await 转走项目预览of(ids, 新负责人));
    } catch {
      return true;
    }
    if (!说法) return true;
    const 转 = await modal.confirm({
      title: 说法.标题,
      content: (
        <div>
          <div style={{ marginBottom: 6 }}>这些项目的负责人会一起改成新负责人：</div>
          <ul style={{ margin: 0, paddingInlineStart: 18, maxHeight: 220, overflowY: "auto" }}>
            {说法.行.map((l, i) => <li key={i} style={{ wordBreak: "break-all" }}>{l}</li>)}
          </ul>
          {说法.还有 && <div style={{ marginTop: 6, color: "var(--ant-color-text-secondary)" }}>{说法.还有}</div>}
        </div>
      ),
      okText: "一起转",
      cancelText: "取消",
    });
    return 转;
  }

  return { 先问转走的项目 };
}
