"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Modal } from "antd";
import { BellOutlined } from "@ant-design/icons";
import { 我的企业提醒, 已读企业提醒 } from "@/app/(app)/ent-notice-actions";
import type { 企业提醒 } from "@/lib/enterprise/notice";

/**
 * 企业版站内提醒（2026-10-26）：系统替某件事叫你（比如自动分配时参与的人都满额了），打开应用时弹一个框。
 * 一条一条「知道了」；关掉框不算读过，下次打开还在。只在企业版挂（layout.tsx）。
 */
export default function EntNoticePrompt() {
  const router = useRouter();
  const [条, set条] = useState<企业提醒[]>([]);
  const [开, set开] = useState(false);

  useEffect(() => {
    let 停 = false;
    void 我的企业提醒().then((r) => {
      if (停 || !r.length) return;
      set条(r);
      set开(true);
    }).catch(() => undefined);
    return () => { 停 = true; };
  }, []);

  if (!条.length) return null;
  const 知道了 = (id: string) => {
    void 已读企业提醒(id).catch(() => undefined);
    const 剩 = 条.filter((x) => x.id !== id);
    set条(剩);
    if (!剩.length) set开(false);
  };
  return (
    <Modal open={开} onCancel={() => set开(false)} footer={null} width={520} title={<><BellOutlined /> 提醒</>}>
      {条.map((x) => (
        <div key={x.id} data-testid={`ent-notice-${x.kind}`} style={{ padding: "10px 0", borderTop: "1px solid var(--line-soft)" }}>
          <div style={{ fontWeight: 600 }}>
            {x.title}{x.times > 1 ? `（${x.times} 次）` : ""}
          </div>
          <div style={{ margin: "4px 0 8px", wordBreak: "break-word" }}>{x.body}</div>
          <div style={{ display: "flex", gap: 8 }}>
            {x.link && (
              <Button size="small" onClick={() => { set开(false); router.push(x.link!); }}>去看看</Button>
            )}
            <Button size="small" type="primary" onClick={() => 知道了(x.id)} data-testid="ent-notice-ok">知道了</Button>
          </div>
        </div>
      ))}
    </Modal>
  );
}
