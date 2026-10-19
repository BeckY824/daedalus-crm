"use client";
/**
 * 打开应用时有没看过的回复：左下角一条小提示「我们回复了你的反馈 · 查看」（2026-10-19）。
 *
 * 不弹模态框、不抢焦点，一次只出一条（最新那一条回复）。
 *   - 点「查看」去「我的反馈」里那一串；点 × 这一条回复以后不再提示（记在本机）
 *   - 15 秒后自己收起（指着它时不收）；没点 × 的话，下次打开应用还没看就再提示一次
 *   - 人已经在「我的反馈」页上就不出
 *
 * 放左下角、挨着左栏，不放右下角：右下角是 AI 栏的输入框和发送键，盖住它比盖住什么都糟；
 * 左下角正对着左栏那枚带红点的反馈键，提示和红点说的是同一件事。
 */
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CloseOutlined } from "@ant-design/icons";
import { useMyFeedback } from "./store";
import { 一句, 最后一条回复 } from "@/lib/feedback-unread";

const 关过键 = "feedback-toast-closed";
const 提示过键 = "feedback-toast-shown";

function 读集(store: Storage | undefined, 键: string): string[] {
  try {
    const v = JSON.parse(store?.getItem(键) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function 加进(store: Storage | undefined, 键: string, id: string) {
  try {
    // 只留最近 50 个：回复 id 只会越来越多
    store?.setItem(键, JSON.stringify([...读集(store, 键).filter((x) => x !== id), id].slice(-50)));
  } catch {
    /* 存不下：最多是下次再提示一次 */
  }
}
const 本地 = () => (typeof window === "undefined" ? undefined : window.localStorage);
const 这次 = () => (typeof window === "undefined" ? undefined : window.sessionStorage);

export default function FeedbackReplyToast({ 去向 }: { 去向: "cloud" | "github" }) {
  const s = useMyFeedback(去向 === "cloud");
  const pathname = usePathname();
  const router = useRouter();
  const 头 = s.反馈.find((f) => f.未读) ?? null;
  const 回 = 头 ? 最后一条回复(头) : null;
  const [在显示, set在显示] = useState<{ feedbackId: string; 回复id: string; 字: string } | null>(null);
  const [看过的回复, set看过的回复] = useState<string | null>(null);
  const 指着 = useRef(false);
  const 在反馈页 = pathname.startsWith("/feedback");

  // 渲染时对一下（不在 effect 里 setState）：只看回复 id，同一条回复不因为别的字段变了再出一次
  const 这条 = 回 && !在反馈页 ? 回.id : null;
  if (这条 !== 看过的回复 && (这条 !== null || !回)) {
    set看过的回复(这条);
    if (!头 || !回) set在显示(null);
    else if (!读集(本地(), 关过键).includes(回.id) && !读集(这次(), 提示过键).includes(回.id)) {
      set在显示({ feedbackId: 头.id, 回复id: 回.id, 字: 一句(回.body, 40) });
    }
  }
  // 到了「我的反馈」页就收起：那里已经看得见了
  if (在反馈页 && 在显示) set在显示(null);

  // 出过一次就记下：这次打开应用不再出（关掉应用再开、还没看，才再提示一次）
  useEffect(() => {
    if (在显示) 加进(这次(), 提示过键, 在显示.回复id);
  }, [在显示]);

  useEffect(() => {
    if (!在显示) return;
    const t = window.setInterval(() => {
      if (!指着.current) set在显示(null);
    }, 15_000);
    return () => window.clearInterval(t);
  }, [在显示]);

  if (!在显示) return null;
  return (
    <div
      className="fbt"
      role="status"
      aria-live="polite"
      data-testid="feedback-toast"
      onMouseEnter={() => (指着.current = true)}
      onMouseLeave={() => (指着.current = false)}
    >
      <div className="fbt-t">
        <b>我们回复了你的反馈</b>
        <span dir="auto">{在显示.字}</span>
      </div>
      <button
        type="button"
        className="fbt-go"
        onClick={() => {
          set在显示(null);
          router.push(`/feedback?id=${encodeURIComponent(在显示.feedbackId)}`);
        }}
      >
        查看
      </button>
      <button
        type="button"
        className="fbt-x"
        aria-label="关闭提示"
        onClick={() => {
          加进(本地(), 关过键, 在显示.回复id);
          set在显示(null);
        }}
      >
        <CloseOutlined />
      </button>
    </div>
  );
}
