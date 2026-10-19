"use client";

import { useRef, useState } from "react";
import { App, Button, Input, InputNumber, Modal } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { 给账号加次数 } from "../actions";

type 种类 = "research" | "ai";
const 名: Record<种类, string> = { research: "背调", ai: "AI" };
const 说明: Record<种类, string> = {
  research: "背调次数：桌面端「AI 背调」一次扣 1 次，和问答的 AI 次数分开记。",
  ai: "AI 次数：桌面端问答 / 写跟进等用的次数，一个问题扣 1 次。",
};
/** 弹框挂在运营台里面：ops.css 的颜色变量写在 .opx 上，挂到 body 下就读不到 */
const 挂在运营台 = () => (document.querySelector(".opx") as HTMLElement | null) ?? document.body;
/** 一次点击的编号：弹框打开时生成，确认时带上。服务器按它判重——连点、网络重发都只加一次 */
const 新编号 = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

/**
 * 「背调 +N」「AI +N」两颗按钮和那个弹框（2026-10-19：次数页、团队详情页、用户详情页共用）。
 * 英文名：react-hooks 规则只认大写字母开头的才是组件。
 * 测试账号不限次数：不摆按钮，写「不限」——以前是整个藏起来，运营者以为「加不了」。
 */
export function AddCreditButtons({ token, account, teamId, 种类们 = ["research", "ai"], size = "small" }: {
  token: string;
  account: { id: string; name: string; 测试: boolean };
  teamId?: string;
  种类们?: 种类[];
  size?: "small" | "middle";
}) {
  const [开, set开] = useState<种类 | null>(null);
  if (account.测试) return <span className="opx-faint" title="测试账号不扣次数，不用加">测试号不限</span>;
  return (
    <span className="opx-row-acts">
      {种类们.map((k) => (
        <Button key={k} size={size} icon={<PlusOutlined />} onClick={() => set开(k)} aria-label={`给 ${account.name} 加${名[k]}次数`}>
          {名[k]} +N
        </Button>
      ))}
      {开 && <AddModal token={token} account={account} teamId={teamId} 种类={开} onClose={() => set开(null)} />}
    </span>
  );
}

function AddModal({ token, account, teamId, 种类, onClose }: { token: string; account: { id: string; name: string }; teamId?: string; 种类: 种类; onClose: () => void }) {
  const { message } = App.useApp();
  const [n, setN] = useState<number | null>(10);
  const [备注, set备注] = useState("");
  const [交, set交] = useState(false);
  // 打开时生成，整个弹框只用这一个：按钮 loading 之前那一瞬间的第二下，也是同一个编号
  const 编号 = useRef(新编号());
  // 状态要等下一次渲染才变，连点的第二下读到的还是 false：另用一个 ref 当场挡住（挡不住的还有服务器按编号判重）
  const 在交 = useRef(false);
  const 合法 = typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1000;

  async function 确认() {
    if (!合法 || 在交.current) return;
    在交.current = true;
    set交(true);
    try {
      const r = await 给账号加次数({ token, accountId: account.id, 种类, n: n!, key: 编号.current, note: 备注, teamId });
      if (r.ok) {
        message.success(r.重复 ? "这次已经加过了，没有重复加" : `给 ${account.name} 加了 ${n} 次${种类 === "ai" ? " AI" : "背调"}`);
        onClose();
      } else message.error(r.error);
    } catch {
      message.error("网络断了，没确认加上：刷新页面看一眼余额再决定要不要重加");
    } finally {
      在交.current = false;
      set交(false);
    }
  }

  return (
    <Modal
      open
      title={`给 ${account.name} 加${名[种类]}次数`}
      onCancel={onClose}
      getContainer={挂在运营台}
      footer={[
        <Button key="c" onClick={onClose}>取消</Button>,
        <Button key="ok" type="primary" loading={交} disabled={!合法} onClick={确认}>
          {合法 ? `确认加 ${n} 次` : "确认"}
        </Button>,
      ]}
    >
      <p className="opx-muted" style={{ marginTop: 0 }}>{说明[种类]} 只加不减，加了撤不回。</p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span>加</span>
        <InputNumber min={1} max={1000} precision={0} value={n} onChange={(v) => setN(v === null ? null : Number(v))} aria-label={`加几次${名[种类]}`} autoFocus />
        <span>次（1–1000）</span>
      </div>
      <Input value={备注} onChange={(e) => set备注(e.target.value)} maxLength={200} placeholder="备注，比如：微信转账 10 次" aria-label="备注" onPressEnter={确认} />
    </Modal>
  );
}
