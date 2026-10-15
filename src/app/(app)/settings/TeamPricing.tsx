import type { 团队价格 } from "@/lib/sync/client";

const 元 = (n: number) => `¥${n}`;

/**
 * 设置 → 团队 · 团队版价格（2026-10-15）。价格存服务器、运营台改（lib/tenant/team-plan.ts），这里只显示；
 * 拿不到（没登录、连不上）就不摆。不做应用内付款：告诉我们团队名字、人数和时长，运营者手动开通 / 续费
 */
export default function TeamPricing({ 价格 }: { 价格: 团队价格 | null | undefined }) {
  if (!价格) return null;
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
      <p className="muted team-price-how">开通、续费、加人：点左下角「反馈」告诉我们团队名字、人数和时长，我们帮你开通。到期前会显示还剩几天；到期后暂停同步，这台电脑上的数据照常能用，续费后自动恢复。</p>
    </section>
  );
}
