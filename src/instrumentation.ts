/**
 * Next.js 服务启动时调一次。企业版开着时起两个钟：飞书 / 钉钉增量同步（见 enterprise-import/sync.ts）、
 * 每天 00:05 的超时回收（见 project/nightly.ts）。
 * 桌面端、团队版服务器不设 CRM_ENTERPRISE，这里什么都不做，也不加载这些代码。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.CRM_ENTERPRISE !== "1") return;
  const { 启动定时 } = await import("./lib/enterprise-import/sync");
  启动定时();
  const { 启动夜扫 } = await import("./lib/project/nightly");
  启动夜扫();
}
