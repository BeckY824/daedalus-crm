/**
 * 适配器：每个原系统一个，只管把记录拉出来，长成 原始记录。映射、清洗、写库都不在这里。
 *
 * Excel 没有「拉」这件事——人把导出文件传上来，excel.ts 读成 原始记录，后面同一条路。
 * 飞书 / 钉钉要客户在他们后台开应用、给权限，拿到之前先占个位，调到就说清楚「还没接」。
 */
import type { 原始记录, 来源 } from "./types";

export interface 适配器 {
  来源: 来源;
  /** 首次全量 */
  拉全量(): Promise<原始记录[]>;
  /** 增量：自 since 之后改过的（原系统给不了就退回全量，靠指纹跳过没变的） */
  拉变化(since: Date | null): Promise<原始记录[]>;
}

export class 还没接 extends Error {}

/** 飞书 / 钉钉的位子：接口权限拿到前，同步调到这里就停下，说人话 */
class 待接适配器 implements 适配器 {
  constructor(public 来源: 来源, private 名字: string) {}
  async 拉全量(): Promise<原始记录[]> {
    throw new 还没接(`${this.名字}接口还没接：要客户在${this.名字}后台开应用、给读取权限后才能拉。先用${this.名字}导出的 Excel 导入。`);
  }
  async 拉变化(): Promise<原始记录[]> {
    return this.拉全量();
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

/** 测试里换掉某个来源的适配器（例如把飞书换成 现成适配器） */
export function 换适配器(来源: 来源, a: 适配器 | null) {
  if (a) 测试用[来源] = a;
  else delete 测试用[来源];
}

export function 取适配器(来源: 来源): 适配器 {
  const 换的 = 测试用[来源];
  if (换的) return 换的;
  if (来源 === "feishu") return new 待接适配器("feishu", "飞书");
  if (来源 === "dingtalk") return new 待接适配器("dingtalk", "钉钉");
  throw new 还没接("Excel 没有自动同步：把新导出的文件再传一次，按原系统 ID 只更新变了的。");
}
