/**
 * 业务配置的服务端读写。类型、默认值与合并逻辑在 business-config.ts（不依赖数据库，客户端也能引）。
 */
import { getSetting, setSetting } from "./settings";
import { BUSINESS_KEY, mergeBusiness, type BusinessConfig } from "./business-config";

export * from "./business-config";

export async function getBusiness(): Promise<BusinessConfig> {
  return mergeBusiness(await getSetting<Partial<BusinessConfig>>(BUSINESS_KEY));
}

export async function saveBusiness(cfg: BusinessConfig): Promise<void> {
  await setSetting(BUSINESS_KEY, mergeBusiness(cfg));
}
