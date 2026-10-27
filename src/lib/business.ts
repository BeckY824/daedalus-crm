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
  // 「业务员能删客户」默认开着：开着就不写进库，库里和老版本一字不差；老板关掉才存 false
  const { salesCanDelete, ...rest } = mergeBusiness(cfg);
  await setSetting(BUSINESS_KEY, salesCanDelete ? rest : { ...rest, salesCanDelete });
}
