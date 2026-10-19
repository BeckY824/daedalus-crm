"use client";
/**
 * 「我的反馈」在页面这边的一份（2026-10-19）：左栏反馈键上的红点、左下角的轻提示、「我的反馈」页共用。
 *
 * 问的是本地服务的 /api/feedback/mine（它再带着设备令牌去问云端，一分钟内问过就用那份）。什么时候问：
 *   - 应用打开（AppShell 挂上）那一下
 *   - 切回应用时，最多一分钟一次
 *   - 壳每几分钟自己问一次云端，问到了推 feedback:changed 过来（desktop/feedback-replies.js → preload-app.js）
 * 不是实时推送：运营台回了，最慢几分钟后这里才知道。
 */
import { useEffect, useSyncExternalStore } from "react";
import type { 带未读的反馈 } from "@/lib/feedback-unread";
import { 最后一条回复 } from "@/lib/feedback-unread";

export type 反馈态 = {
  /** 问过一次了（不管问没问到）。页面据此决定画骨架还是画空状态 */
  载好: boolean;
  /** false：不是桌面端、没登录云端、云端是老版本没有这条接口——都当作没有回复 */
  可用: boolean;
  反馈: 带未读的反馈[];
  未读数: number;
  /** 这一次没问到（断网）。有旧的照样画旧的 */
  出错: boolean;
};

let 态: 反馈态 = { 载好: false, 可用: false, 反馈: [], 未读数: 0, 出错: false };
const 听众 = new Set<() => void>();
let 上次问 = 0;
let 在问: Promise<void> | null = null;

function 设(新: 反馈态) {
  态 = 新;
  for (const f of 听众) f();
}

/** 新 = true：让本地服务别用一分钟内那份，直接去问云端（打开「我的反馈」页那一下） */
export function 刷新我的反馈({ 新 = false }: { 新?: boolean } = {}): Promise<void> {
  if (在问 && !新) return 在问;
  上次问 = Date.now();
  在问 = (async () => {
    try {
      const r = await fetch(`/api/feedback/mine${新 ? "?fresh=1" : ""}`, { cache: "no-store" });
      const j = (await r.json()) as { 可用?: boolean; 反馈?: 带未读的反馈[]; 未读数?: number };
      if (!r.ok) throw new Error(String(r.status));
      // 问不到云端时本地服务回 可用:false、原因:连不上——手上有旧的就留着旧的，不让红点一闪没了
      if (!j.可用 && 态.可用 && (j as { 原因?: string }).原因 === "连不上") return 设({ ...态, 载好: true, 出错: true });
      设({ 载好: true, 可用: j.可用 === true, 反馈: Array.isArray(j.反馈) ? j.反馈 : [], 未读数: Number(j.未读数) || 0, 出错: false });
    } catch {
      设({ ...态, 载好: true, 出错: true });
    } finally {
      在问 = null;
    }
  })();
  return 在问;
}

/** 点开了一串：本地马上收掉红点（不等回音），再告诉本地服务记下 */
export function 标已读(f: 带未读的反馈) {
  const 回 = 最后一条回复(f);
  if (!回 || !f.未读) return;
  const 反馈 = 态.反馈.map((x) => (x.id === f.id ? { ...x, 未读: false } : x));
  设({ ...态, 反馈, 未读数: 反馈.filter((x) => x.未读).length });
  void fetch("/api/feedback/mine/seen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feedbackId: f.id, messageId: 回.id }),
  }).catch(() => {});
}

/** 接着说发出去了：把云端回的那条接到串尾，不用等下一次问 */
export function 接上(feedbackId: string, 消息: 带未读的反馈["消息"][number]) {
  const 反馈 = 态.反馈.map((x) => (x.id === feedbackId && !x.消息.some((m) => m.id === 消息.id) ? { ...x, 消息: [...x.消息, 消息], 未读: false } : x));
  设({ ...态, 反馈, 未读数: 反馈.filter((x) => x.未读).length });
}

const 订阅 = (f: () => void) => {
  听众.add(f);
  return () => 听众.delete(f);
};
const 空态: 反馈态 = { 载好: false, 可用: false, 反馈: [], 未读数: 0, 出错: false };

type 壳反馈桥 = { onChanged(cb: () => void): () => void };

/**
 * 读这份状态。启用 = false（自部署版：反馈去 GitHub）什么都不问。
 * 挂了好几处（左栏一枚、手机顶栏一枚、轻提示、页面），问只问一次：在问的那次大家共用
 */
export function useMyFeedback(启用: boolean): 反馈态 {
  const s = useSyncExternalStore(订阅, () => 态, () => 空态);
  useEffect(() => {
    if (!启用) return;
    if (!态.载好 && !在问) void 刷新我的反馈();
    const 回来 = () => {
      if (Date.now() - 上次问 > 60_000) void 刷新我的反馈();
    };
    window.addEventListener("focus", 回来);
    const 壳 = (window as unknown as { desktopFeedback?: 壳反馈桥 }).desktopFeedback;
    const 不听 = 壳?.onChanged(() => void 刷新我的反馈());
    return () => {
      window.removeEventListener("focus", 回来);
      不听?.();
    };
  }, [启用]);
  return 启用 ? s : 空态;
}
