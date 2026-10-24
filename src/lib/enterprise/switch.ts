/**
 * 企业版开关（私有部署，2026-10-24）。
 *
 * 只认环境变量 CRM_ENTERPRISE=1。企业版部署包的 docker-compose.yml 里写死开着；
 * 桌面端、团队版、云端都不设 = 关，行为和现在完全一样。
 *
 * 只在服务端读：运行时环境变量进不了浏览器包（NEXT_PUBLIC_ 是构建期写死的，
 * 而同一个镜像两种都要能跑）。客户端组件要用，由服务端组件读了当 prop 传下去。
 *
 * 企业版里每条组织规则还有自己的开关（存 Setting），先过这一道再看规则自己的。
 */
export function 企业版(): boolean {
  return process.env.CRM_ENTERPRISE === "1";
}
