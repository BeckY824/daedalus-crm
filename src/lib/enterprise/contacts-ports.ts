/**
 * 企业版 · 通讯录端口（10-26）：飞书 / 企业微信 / 钉钉 / 微信 四个口先留好。
 * 飞书、钉钉接好了（org-sync.ts 按凭据建适配器）；企业微信、微信先占位，调到就说「还没接」，不假装拉到了空通讯录。
 * 以后接一家：写它的适配器（实现 通讯录适配器），把 接好了 改成 true，再加进 org-sync 的 通讯录来源。
 */
import { 还没接 } from "@/lib/enterprise-import/adapter";
import type { 通讯录 } from "@/lib/enterprise-import/types";
import type { 通讯录来源 } from "./org-sync";

export type 通讯录端口 = "feishu" | "wecom" | "dingtalk" | "wechat";

export const 通讯录端口们: { 端口: 通讯录端口; 名: string; 接好了: boolean }[] = [
  { 端口: "feishu", 名: "飞书", 接好了: true },
  { 端口: "wecom", 名: "企业微信", 接好了: false },
  { 端口: "dingtalk", 名: "钉钉", 接好了: true },
  { 端口: "wechat", 名: "微信", 接好了: false },
];

export interface 通讯录适配器 {
  拉通讯录(): Promise<通讯录>;
}

/** 占位：拉的时候直接说还没接 */
export class 占位通讯录 implements 通讯录适配器 {
  constructor(private 名: string) {}
  async 拉通讯录(): Promise<通讯录> {
    throw new 还没接(`${this.名}通讯录还没接上，现在只能从飞书或钉钉同步`);
  }
}

export const 端口接好了 = (p: 通讯录端口): p is 通讯录来源 => 通讯录端口们.some((x) => x.端口 === p && x.接好了);

/** 没接好的端口给占位适配器；接好的走 org-sync 按凭据建，这里返回 null */
export function 占位适配器(p: 通讯录端口): 通讯录适配器 | null {
  if (端口接好了(p)) return null;
  return new 占位通讯录(通讯录端口们.find((x) => x.端口 === p)!.名);
}
