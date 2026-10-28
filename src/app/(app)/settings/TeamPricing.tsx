import type { 团队价格 } from "@/lib/sync/client";

const 元 = (n: number) => `¥${n}`;

/**
 * 设置 → 团队 · 团队版价格（2026-10-15）。价格存服务器、运营台改（lib/tenant/team-plan.ts），这里只显示；
 * 没登录就不摆；登录了但连不上，说一句稍后再看。不做应用内付款：告诉我们团队名字、人数和时长，运营者手动开通 / 续费
 */
export default function TeamPricing({ 价格, 能用 = false }: { 价格: 团队价格 | null | undefined; 能用?: boolean }) {
  // 登录了却拿不到（超时、断网、5xx）：留着这一块说一句，别让上面「价格见下方」指向空处（2026-10-28 D-03）
  if (!价格) return 能用 ? (
    <section className="team-card" data-testid="team-pricing">
      <h3>团队版价格</h3>
      <p className="muted">暂时连不上云端，价格读不出来，稍后再打开这一页看。开通、续费照样可以点左下角「反馈」告诉我们。</p>
    </section>
  ) : null;
  return (
    <section className="team-card" data-testid="team-pricing">
      <h3>团队版价格</h3>
      <p className="muted">
        按人数计，建团队的人也算一人；买得越久越便宜。{价格.trialDays > 0 && <>开通后可以先免费试用 {价格.trialDays} 天。</>}
      </p>
      <ul className="team-prices">
        {价格.prices.map((p) => (
          <li key={p.months}>
            <span className="team-price-k">{p.label}</span>
            <b className="team-price-v">
              {元(p.perSeat)}
              <small> / 人</small>
            </b>
            <span className="muted">{p.months > 1 ? `折合每人每月 ${元(p.perMonth)}` : "每人每月"}</span>
          </li>
        ))}
      </ul>
      <p className="muted team-price-how">开通、续费、加人：点左下角「反馈」告诉我们团队名字、人数和时长，我们帮你开通。定下的人数就是团队上限（含老板），满了要加人再告诉我们。到期前会显示还剩几天；到期后暂停同步，这台电脑上的数据照常能用，续费后自动恢复。</p>
    </section>
  );
}
