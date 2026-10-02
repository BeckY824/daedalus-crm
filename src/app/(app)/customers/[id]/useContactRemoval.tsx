"use client";

import { App, Button } from "antd";
import { useRouter } from "next/navigation";
import { useBusiness } from "@/lib/business-client";
import { deleteContact, deleteUnassignedContact, detachContact, restoreContact, undoDetachContact } from "./actions";

/**
 * 拿掉一位联系人的两条路，客户详情和联系人页共用（2026-10-01 用户反馈）。
 *
 *   只移出   —— 客户详情上不再有他，联系人页里还在、写「未归属」，以后能挂到别的客户下面
 *   彻底删除 —— 联系人页里也没了（原来点删除就是这一条，用户删完才发现）
 *
 * 两条都给一次「撤销」：移出撤回去关键联系人原样回来；删除撤回去原来那几条跟进也接回来。
 */
export function useContactRemoval() {
  const { message, modal } = App.useApp();
  const router = useRouter();
  const b = useBusiness();

  async function 移出(c: { id: string; name: string }) {
    const r = await detachContact(c.id);
    if (!r.ok) return void message.error(r.error);
    router.refresh();
    const key = `contact-${c.id}`;
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          「{c.name}」已移出，联系人页里还留着
          <Button
            type="link"
            size="small"
            onClick={async () => {
              message.destroy(key);
              const u = await undoDetachContact(c.id, r.原来是关键);
              if (!u.ok) return void message.error(u.error);
              message.success(`「${c.name}」回来了`);
              router.refresh();
            }}
          >
            撤销
          </Button>
        </span>
      ),
    });
  }

  /** `未归属` = 联系人页上那种从客户上移出过的人，删的是另一张表 */
  async function 彻底删(c: { id: string; name: string; 未归属?: boolean }) {
    const r = c.未归属 ? await deleteUnassignedContact(c.id) : await deleteContact(c.id);
    if (!r.ok) {
      router.refresh();
      return void message.error(r.error);
    }
    router.refresh();
    const key = `contact-${c.id}`;
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          「{c.name}」已删除
          <Button
            type="link"
            size="small"
            onClick={async () => {
              message.destroy(key);
              const u = await restoreContact(r.快照);
              if (!u.ok) return void message.error(u.error);
              message.success(`「${c.name}」回来了`);
              router.refresh();
            }}
          >
            撤销
          </Button>
        </span>
      ),
    });
  }

  /**
   * 客户详情上点删除：先问是只移出还是彻底删。主钮是「只移出」——更不伤数据的那个，
   * 回车直接按的也是它。
   */
  function 问怎么拿掉(c: { id: string; name: string }) {
    const 框 = modal.confirm({
      title: `把「${c.name}」从这位${b.customer}上拿掉？`,
      content: (
        <div style={{ lineHeight: 1.7 }}>
          <div>只移出：联系人页里还留着，写「未归属」，以后能挂到别的{b.customer}下面。</div>
          <div>彻底删除：联系人页里也一起删掉。</div>
          <div className="muted">两种都不会删他的跟进记录。</div>
        </div>
      ),
      footer: (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <Button onClick={() => 框.destroy()}>取消</Button>
          <Button danger onClick={() => { 框.destroy(); void 彻底删(c); }}>
            彻底删除
          </Button>
          <Button type="primary" autoFocus onClick={() => { 框.destroy(); void 移出(c); }}>
            只移出
          </Button>
        </div>
      ),
    });
  }

  return { 移出, 彻底删, 问怎么拿掉 };
}
