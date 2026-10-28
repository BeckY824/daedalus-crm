/**
 * 设置 → 团队 · 团队版免费（2026-10-28 用户：「桌面端的价格按这个来，目前不标价了」——小团队免费开源）。
 * 原来这里列服务器上的每人价格表（2026-10-15），现在不摆价格、不读价格表，也就不用等云端；
 * 开通和到期那套照旧（运营者在运营台开），开通、加人还是点「反馈」告诉我们
 */
export default function TeamPricing() {
  return (
    <section className="team-card" data-testid="team-pricing">
      <h3>团队版免费</h3>
      <p className="muted team-price-how">团队版现在免费用，建团队的人也算一人。开通、加人：点左下角「反馈」告诉我们团队名字和人数，我们帮你开通。定下的人数就是团队上限（含老板），满了要加人再告诉我们。</p>
    </section>
  );
}
