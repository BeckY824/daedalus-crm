/**
 * 适配器：每个原系统一个，只管把记录拉出来，长成 原始记录。映射、清洗、写库都不在这里。
 *
 * Excel 没有「拉」这件事——人把导出文件传上来，excel.ts 读成 原始记录，后面同一条路。
 * 飞书 / 钉钉要客户在他们后台开应用、给权限，拿到之前先占个位，调到就说清楚「还没接」。
 */
import { decryptSecret, getSetting } from "../settings";
import { 钉钉适配器, type 钉钉配置 } from "./dingtalk";
import { 飞书适配器, type 飞书配置 } from "./feishu";
import { 真联网, type 联网 } from "./net";
import type { 原始记录, 实体, 来源 } from "./types";

/** 每类现在有哪些列（拉的时候顺手读到的列描述，换成和 原始记录.字段 一样的列名） */
export type 现有列 = Partial<Record<实体, Set<string>>>;

export interface 适配器 {
  来源: 来源;
  /** 首次全量 */
  拉全量(): Promise<原始记录[]>;
  /** 增量：自 since 之后改过的（原系统给不了就退回全量，靠指纹跳过没变的） */
  拉变化(since: Date | null): Promise<原始记录[]>;
  /** 上一次 拉全量 / 拉变化 时原系统每类的列（按列描述，不看这次拉到哪几条）。给不了的不实现，同步就只看拉到的记录 */
  现有列?(): 现有列 | null;
}

export class 还没接 extends Error {}

/** 接口凭据和表配置存在 Setting `entConn.<来源>`（私有部署的库里，不进环境变量） */
export const 连接键 = (来源: 来源) => `entConn.${来源}`;

/** 密的字段在库里存密文（enc:v1:…）：用之前解开；解不开（密钥换了）当没填。老的明文照样能用 */
export function 解连接配置(c: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!c) return c;
  const 出 = { ...c };
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === "string" && v.startsWith("enc:v1:")) {
      const 明 = decryptSecret(v);
      if (明 === null) delete 出[k];
      else 出[k] = 明;
    }
  }
  return 出;
}

/** 读连接配置（已解密） */
export async function 读连接配置(来源: 来源): Promise<Record<string, unknown> | null> {
  return 解连接配置(await getSetting<Record<string, unknown>>(连接键(来源)));
}

/**
 * 飞书 / 钉钉：每次拉的时候才读配置。没配（或缺必填项）就停下说人话，同步记「没接」；
 * 配好了就交给真正的适配器。
 */
class 按配置适配器 implements 适配器 {
  private 上次用的: 适配器 | null = null;
  constructor(public 来源: "feishu" | "dingtalk", private 名字: string) {}
  private async 真的(): Promise<适配器> {
    return (this.上次用的 = await this.按配置());
  }
  private async 按配置(): Promise<适配器> {
    const c = await 读连接配置(this.来源);
    const 有 = (k: string) => typeof c?.[k] === "string" && (c[k] as string).trim() !== "";
    if (c && this.来源 === "feishu" && 有("appId") && 有("appSecret") && Array.isArray(c.表们) && c.表们.length) {
      return new 飞书适配器(c as unknown as 飞书配置, 用的网);
    }
    if (c && this.来源 === "dingtalk" && 有("appKey") && 有("appSecret") && 有("操作人UserId")) {
      return new 钉钉适配器(c as unknown as 钉钉配置, 用的网, 用的网 === 真联网 ? undefined : 0);
    }
    throw new 还没接(`${this.名字}接口还没接：要客户在${this.名字}后台开应用、给读取权限后才能拉。先用${this.名字}导出的 Excel 导入。`);
  }
  async 拉全量(): Promise<原始记录[]> {
    return (await this.真的()).拉全量();
  }
  async 拉变化(since: Date | null): Promise<原始记录[]> {
    return (await this.真的()).拉变化(since);
  }
  现有列() {
    return this.上次用的?.现有列?.() ?? null;
  }
}

/** 测试和试跑演示用：手里已有的一组记录（since 之后的按 改于 筛不了，就全给，靠指纹跳过） */
export class 现成适配器 implements 适配器 {
  constructor(public 来源: 来源, private 记录: () => 原始记录[] | Promise<原始记录[]>) {}
  async 拉全量() {
    return this.记录();
  }
  async 拉变化() {
    return this.记录();
  }
}

const 测试用: Partial<Record<来源, 适配器>> = {};
let 用的网: 联网 = 真联网;

/** 测试里让按配置建的飞书 / 钉钉适配器走假网（测「存好连接配置 → 取适配器」这条线上走的路）；null 换回真网 */
export function 换联网(网: 联网 | null) {
  用的网 = 网 ?? 真联网;
}

/** 现在用的网（组织架构同步建适配器时跟着用，测试里换了假网就一起走假网） */
export const 当前联网 = () => 用的网;

/** 测试里换掉某个来源的适配器（例如把飞书换成 现成适配器） */
export function 换适配器(来源: 来源, a: 适配器 | null) {
  if (a) 测试用[来源] = a;
  else delete 测试用[来源];
}

export function 取适配器(来源: 来源): 适配器 {
  const 换的 = 测试用[来源];
  if (换的) return 换的;
  if (来源 === "feishu") return new 按配置适配器("feishu", "飞书");
  if (来源 === "dingtalk") return new 按配置适配器("dingtalk", "钉钉");
  throw new 还没接("Excel 没有自动同步：把新导出的文件再传一次，按原系统 ID 只更新变了的。");
}
