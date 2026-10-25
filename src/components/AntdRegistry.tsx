"use client";

/* 替代 @ant-design/nextjs-registry 的 AntdRegistry。原版每个请求 new 一份 cssinjs 缓存，
   页面上每个 antd 组件的样式（token 推导 + 样式对象 + stylis 编译）每次请求都从头算一遍——
   客户列表页一次 HTML 请求里这块占三成 CPU，30 人并发时全排在主线程上。

   主题只有一套（lib/theme.ts，cssVar 固定），同一个 key 算出来的样式每次都一样，
   所以服务端把算好的值存在进程里跨请求复用；每个请求另记「本次用到了哪些 key、按什么先后」，
   吐出来的 <style> 和原版逐字相同（同样的 key、同样的先后、同样分批 once）。
   浏览器端照旧每次挂载 createCache()，和原版一样。 */
import { createCache, extractStyle, StyleProvider } from "@ant-design/cssinjs";
import { useServerInsertedHTML } from "next/navigation";
import { useState } from "react";

type Entity = ReturnType<typeof createCache>;
type Value = [number, unknown];

/* 进程里共用的「key → 算好的值」。key 由组件 + 主题 hash 组成，单主题下是有限的几千个；
   万一主题变多撑大了就整个清掉重算，不至于一直涨 */
const 共用 = new Map<string, Value>();
const 共用上限 = 20000;

/* 一个请求一份：取值先看本次、再看进程共用；写入同时记本次的先后（extractStyle 按它排同 order 的样式），
   字段和 cssinjs 的 Cache 实体同名，hooks 和 extractStyle 只用到这几样 */
export class 本次请求缓存 {
  instanceId = Math.random().toString(12).slice(2);
  cache = new Map<string, Value>();
  updateTimes = new Map<string, number>();
  extracted = new Set<string>();
  #次序 = 0;

  get(keys: (string | number)[]) {
    return this.opGet(keys.join("%"));
  }
  opGet(key: string) {
    return this.cache.get(key) || null;
  }
  update(keys: (string | number)[], valueFn: (prev?: Value) => Value | null) {
    this.opUpdate(keys.join("%"), valueFn);
  }
  opUpdate(key: string, valueFn: (prev?: Value) => Value | null) {
    const next = valueFn(this.cache.get(key) ?? 共用.get(key));
    if (next === null) {
      this.cache.delete(key);
      this.updateTimes.delete(key);
      return;
    }
    this.cache.set(key, next);
    this.updateTimes.set(key, this.#次序++);
    if (共用.size >= 共用上限) 共用.clear();
    共用.set(key, next);
  }
}

export default function AntdRegistry({ children }: { children: React.ReactNode }) {
  const [cache] = useState<Entity>(() =>
    typeof window === "undefined" ? (new 本次请求缓存() as unknown as Entity) : createCache(),
  );
  useServerInsertedHTML(() => {
    const styleText = extractStyle(cache, { plain: true, once: true });
    if (styleText.includes('.data-ant-cssinjs-cache-path{content:"";}')) return null;
    return (
      <style
        id="antd-cssinjs"
        // 和原版一样排在 antd 浏览器端后插的样式前面
        data-rc-order="prepend"
        data-rc-priority="-1000"
        dangerouslySetInnerHTML={{ __html: styleText }}
      />
    );
  });
  return <StyleProvider cache={cache}>{children}</StyleProvider>;
}
