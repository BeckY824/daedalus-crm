/**
 * 业务配置的服务端读写。类型、默认值与合并逻辑在 business-config.ts（不依赖数据库，客户端也能引）。
 */
import { getSetting, setSetting } from "./settings";
import { BUSINESS_KEY, mergeBusiness, type BusinessConfig } from "./business-config";
import { FOLLOW_TYPES_KEY, mergeFollowTypes, type FollowTypeConfig } from "./follow-types";

export * from "./business-config";

export async function getBusiness(): Promise<BusinessConfig> {
  return { ...mergeBusiness(await getSetting<Partial<BusinessConfig>>(BUSINESS_KEY)), followTypes: await getFollowTypes() };
}

/** 跟进渠道单独存一项（见 business-config 的 followTypes） */
export async function getFollowTypes(): Promise<FollowTypeConfig> {
  return mergeFollowTypes(await getSetting(FOLLOW_TYPES_KEY));
}

export async function saveFollowTypes(cfg: FollowTypeConfig): Promise<void> {
  await setSetting(FOLLOW_TYPES_KEY, mergeFollowTypes(cfg));
}

export async function saveBusiness(cfg: BusinessConfig): Promise<void> {
  // mergeBusiness 出来的不带 followTypes：渠道走 saveFollowTypes，这里存不进去
  // 「业务员能删客户」默认开着：开着就不写进库，库里和老版本一字不差；老板关掉才存 false
  const { salesCanDelete, ...rest } = mergeBusiness(cfg);
  await setSetting(BUSINESS_KEY, salesCanDelete ? rest : { ...rest, salesCanDelete });
}
