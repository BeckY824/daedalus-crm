import { multiTenant } from "@/lib/tenant/context";
import { 本地模式 } from "@/lib/desktop/cloud";
import MyFeedbackView from "./MyFeedbackView";

export const dynamic = "force-dynamic";

/**
 * 我的反馈（2026-10-19）：我发过的反馈，和我们的回复。点左栏反馈键上的红点、系统通知、左下角的轻提示都到这里，
 * 带 ?id= 直接落在那一串。数据在云端，页面自己去问（components/feedback/store.ts），服务端这里只定「反馈去哪」。
 */
export default function MyFeedbackPage() {
  return <MyFeedbackView 去向={本地模式() || multiTenant() ? "cloud" : "github"} />;
}
