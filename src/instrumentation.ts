/**
 * Next.js 服务启动时调一次。现在只做一件事：企业版开着时起飞书 / 钉钉增量同步的钟（见 enterprise-import/sync.ts）。
 * 桌面端、团队版服务器不设 CRM_ENTERPRISE，这里什么都不做，也不加载同步代码。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.CRM_ENTERPRISE !== "1") return;
  const { 启动定时 } = await import("./lib/enterprise-import/sync");
  启动定时();
}
