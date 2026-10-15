"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Tag } from "antd";
import { DesktopOutlined, MobileOutlined } from "@ant-design/icons";
import { smartTime } from "@/lib/utils";
import { 我的设备动作, 移除设备动作 } from "./team-actions";

type 一台 = { device: string; 种类: "电脑" | "手机"; label: string; 连上: string; 最近同步: string | null; 这台: boolean };

/**
 * 设置 → 团队 → 我的设备（2026-10-15 多设备同步；原来只列手机的 PhonesCard）。
 * 本人在团队里的电脑和手机列在一起。新电脑登录同一个账号后选「在我的另一台电脑上允许」、手机登录后，这台会弹出授权框
 * （components/MobileAuthPrompt）；授权过的都列在这里，不用了 / 丢了就移除：那台马上退出登录，老板那台随后换一把钥匙。
 * 每人最多 3 台（电脑和手机合计，10-15 你定）。正在用的这台不在这里移除（要停用请「退出团队」）。
 */
export default function DevicesCard() {
  const { message, modal } = App.useApp();
  const [列, set列] = useState<一台[] | null>(null);
  const [上限, set上限] = useState(3);
  const [地址, set地址] = useState("");
  const [错, set错] = useState<string | null>(null);

  const 收 = useCallback((r: Awaited<ReturnType<typeof 我的设备动作>>) => {
    if (r.ok) { set列(r.设备); set上限(r.上限); set地址("地址" in r ? String(r.地址) : ""); set错(null); } else set错(r.error);
  }, []);
  const 刷 = useCallback(() => 我的设备动作().then(收), [收]);
  useEffect(() => {
    let 还在 = true;
    void 我的设备动作().then((r) => { if (还在) 收(r); });
    // 授权框那边点了允许，这里跟着出现
    const on = () => void 刷();
    window.addEventListener("daedalus:mobile-linked", on);
    return () => { 还在 = false; window.removeEventListener("daedalus:mobile-linked", on); };
  }, [收, 刷]);

  function 移除(d: 一台) {
    modal.confirm({
      title: `移除「${d.label}」？`,
      content: d.种类 === "电脑"
        ? "那台电脑会马上退出登录、不能再同步；它上面已有的数据还在那台电脑上。之后老板的电脑会自动换一把团队钥匙。"
        : "这台手机会马上退出登录、不能再同步。已经在手机上的内容请在手机浏览器里清掉网站数据。",
      okText: "移除", okButtonProps: { danger: true }, cancelText: "取消",
      onOk: async () => {
        const r = await 移除设备动作(d.device, d.label);
        if (r.ok) { message.success("已移除"); void 刷(); } else message.error(r.error);
      },
    });
  }

  const 满了 = !!列 && 列.length >= 上限;
  return (
    <section className="team-card" data-testid="team-devices">
      <h3>我的设备{列 ? ` ${列.length} / ${上限}` : ""}</h3>
      <p className="muted">
        同一个账号可以在家里、公司的电脑和手机上一起用，最多 {上限} 台（电脑和手机合计）。
        <b>新电脑</b>：登录这个账号，在「设置 → 团队」里点「在我的另一台电脑或手机上允许」，再在这台（或已连上的手机）上点「允许」。
        <b>手机</b>：用手机浏览器打开{地址 ? <> <b>{地址}</b> </> : "手机版"}，用这个账号登录，再在这台（或已连上的手机）上点「允许」。
        数据加密后经我们转交，我们看不到内容。
      </p>
      {错 && <p className="muted">{错}</p>}
      {列 && 列.length > 0 && (
        <ul className="team-members">
          {列.map((d) => (
            <li key={d.device}>
              {d.种类 === "电脑" ? <DesktopOutlined /> : <MobileOutlined />}
              <b>{d.label}</b>
              {d.这台 && <Tag>这台</Tag>}
              <span className="muted">
                {`连上于 ${smartTime(d.连上)}`}
                {d.最近同步 ? ` · 最近同步 ${smartTime(d.最近同步)}` : ""}
              </span>
              {!d.这台 && <Button size="small" type="text" danger onClick={() => 移除(d)} aria-label={`移除 ${d.label}`}>移除</Button>}
            </li>
          ))}
        </ul>
      )}
      {满了 && <p className="muted">已经 {上限} 台了：要连新的，先移除一台不用的。</p>}
    </section>
  );
}
