"use client";

import { App, Checkbox } from "antd";
import { useRouter } from "next/navigation";
import { useBusiness } from "@/lib/business-client";
import { money } from "@/lib/utils";
import { 删除确认标题 } from "@/lib/list-select";
import { deleteCustomers, 删除前清点, type 删除清点 } from "./actions";

/**
 * 删客户的确认（单条、批量共用）。2026-10-02 排查 B1。
 *
 * 原来只写「其跟进记录、待办与签约记录将一并删除」——实际还删商机、计划、跟进原文，
 * 单条删除连「不可恢复」都没写，和那条「删联系人，联系人页也没了」是同一类：删完才发现。
 * 现在先数一遍，照实说会一起删掉什么、什么会留下（联系人搬进未归属）。
 * 有签约的多拦一道：签约删了，数据页的历史业绩跟着少，得勾一下才能删。
 */
export function useDeleteCustomers() {
  const { message, modal } = App.useApp();
  const router = useRouter();
  const b = useBusiness();

  async function 问删除(rows: { id: string; name: string }[], 删完?: () => void) {
    const ids = rows.map((r) => r.id);
    let 数: 删除清点;
    try {
      数 = await 删除前清点(ids);
    } catch {
      return void message.error("没数清楚会一起删掉什么，先别删，刷新再试");
    }

    const 一起删 = [
      数.跟进 && `${数.跟进} 条跟进记录`,
      数.商机 && `${数.商机} 个商机`,
      数.计划和待办 && `${数.计划和待办} 条计划和待办`,
    ].filter(Boolean);
    const 有签约 = 数.签约 > 0;

    const 框 = modal.confirm({
      title: 删除确认标题(rows.map((r) => r.name), rows.length, b.customer),
      width: 460,
      content: (
        <div style={{ lineHeight: 1.8 }}>
          {一起删.length > 0 && <div>会一起删掉：{一起删.join("、")}。</div>}
          {有签约 && (
            <div>
              还有 <b>{数.签约} 笔签约（{money(数.签约金额)}）</b>，数据页的业绩会跟着少。
            </div>
          )}
          {数.联系人 > 0 && <div>{数.联系人} 位联系人不删，留在联系人页，写「未归属」。</div>}
          {数.线索 > 0 && <div>{数.线索} 条线索还在，只是不再连着这位{b.customer}。</div>}
          <div style={{ color: "var(--danger-text)" }}>删除后不能恢复。</div>
          {有签约 && (
            <Checkbox
              style={{ marginTop: 8 }}
              onChange={(e) => 框.update({ okButtonProps: { danger: true, disabled: !e.target.checked } })}
            >
              我知道签约也会删掉
            </Checkbox>
          )}
        </div>
      ),
      okText: "删除",
      okButtonProps: { danger: true, disabled: 有签约 },
      cancelText: "取消",
      async onOk() {
        const res = await deleteCustomers(ids);
        if (!res.ok) return void message.error(res.error, 8);
        删完?.();
        message.success(
          `已删除 ${res.deleted} 位${b.customer}` + (res.留下联系人 ? `，${res.留下联系人} 位联系人留在联系人页` : ""),
        );
        router.refresh();
      },
    });
  }

  return { 问删除 };
}
