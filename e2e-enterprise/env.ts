import path from "node:path";

/** 企业版 e2e 的库：prepare.ts 建、ent-import.spec.ts 直接读来对账 */
export const ENT_E2E_DB = path.resolve(__dirname, "../prisma/e2e-ent.db");
