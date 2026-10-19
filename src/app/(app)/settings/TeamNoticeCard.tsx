"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Switch, Typography } from "antd";

/** 提醒设置里和同事新建有关的三项（desktop/reminders.js 默认：客户、商机开，跟进关） */
type 同事开关 = { 同事客户: boolean; 同事商机: boolean; 同事跟进: boolean };
type 桥 = { 设置(): Promise<Partial<同事开关>>; 改设置(s: Partial<同事开关>): Promise<Partial<同事开关>> };

const 无订阅 = () => () => {};

/**
 * 设置 → 团队，老板那台才有：同事新建了客户 / 商机 / 跟进，电脑弹系统通知（2026-10-19 客户反馈第 1 条）。
 * 开关存在壳那边（窗口关着也是壳在发），和「提醒」那几个开关同一份。老版本的壳不认这三项：整张卡不出现。
 */
export default function TeamNoticeCard() {
  const b = useSyncExternalStore(无订阅, () => (window as unknown as { desktopReminders?: 桥 }).desktopReminders, () => undefined);
  const [设置, set设置] = useState<同事开关 | null>(null);
  useEffect(() => {
    b?.设置().then((s) => {
      if (typeof s?.同事客户 === "boolean") set设置({ 同事客户: s.同事客户, 同事商机: s.同事商机 !== false, 同事跟进: s.同事跟进 === true });
    }).catch(() => {});
  }, [b]);
  if (!b || !设置) return null;
  const 改 = (部分: Partial<同事开关>) => {
    set设置({ ...设置, ...部分 });
    b.改设置(部分).then((s) => { if (typeof s?.同事客户 === "boolean") set设置({ 同事客户: s.同事客户, 同事商机: s.同事商机 !== false, 同事跟进: s.同事跟进 === true }); }).catch(() => {});
  };
  const 行 = (开: boolean, 键: keyof 同事开关, 名: string, 说明: string) => (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "6px 0" }}>
      <Switch size="small" checked={开} onChange={(v) => 改({ [键]: v })} style={{ marginTop: 2 }} aria-label={名} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{名}</div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{说明}</Typography.Text>
      </div>
    </div>
  );
  return (
    <section className="team-card" data-testid="team-notice-card">
      <h3>同事新建时提醒我</h3>
      <p className="muted">同事录了新客户、新商机，这台电脑弹一条系统通知，点一下直接到那一条。同一个人一分钟内录好几条只弹一条；电脑离线回来同步到很多条，也只合成一条。你自己录的不提醒。</p>
      {行(设置.同事客户, "同事客户", "新客户", "同事新建了客户")}
      {行(设置.同事商机, "同事商机", "新商机", "同事新建了商机")}
      {行(设置.同事跟进, "同事跟进", "新跟进", "同事每记一条跟进都提醒——人多的时候会比较多，默认关")}
    </section>
  );
}
