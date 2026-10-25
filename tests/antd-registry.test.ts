import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createCache, extractStyle, StyleProvider } from "@ant-design/cssinjs";
import { Button, Card, ConfigProvider, Input, Select, Table, Tag } from "antd";
import zhCN from "antd/locale/zh_CN";
import { themeConfig } from "@/lib/theme";
import { 本次请求缓存 } from "@/components/AntdRegistry";

type Entity = ReturnType<typeof createCache>;

const 页面A = () => [h(Button, { key: 1, type: "primary" }, "保存"), h(Input, { key: 2 }), h(Tag, { key: 3 }, "A")];
const 页面B = () => [h(Card, { key: 1, title: "卡" }, "x"), h(Select, { key: 2, options: [] }), h(Table, { key: 3, dataSource: [], columns: [] })];

/* 模拟一次 HTML 请求：分两批渲染、每批后 once 抽一次（流式里 useServerInsertedHTML 分批调用就是这样） */
function 一次请求(cache: Entity, 批次: (() => ReactNode)[]) {
  return 批次.map((内容) => {
    renderToStaticMarkup(h(StyleProvider, { cache }, h(ConfigProvider, { locale: zhCN, theme: themeConfig }, 内容())));
    return extractStyle(cache, { plain: true, once: true });
  });
}

it("跨请求复用的样式缓存吐出的 <style> 和每次新建缓存逐字相同", () => {
  const 原版 = 一次请求(createCache(), [页面A, 页面B]);
  expect(原版[0].length).toBeGreaterThan(1000);

  // 先跑一个别的页面，把进程里共用的缓存填上一些本页不用的 key
  一次请求(new 本次请求缓存() as unknown as Entity, [页面B]);
  // 第一次（部分 key 已算过）和第二次（全部命中共用）都要和原版一样，且不带别的页面的样式
  expect(一次请求(new 本次请求缓存() as unknown as Entity, [页面A, 页面B])).toEqual(原版);
  expect(一次请求(new 本次请求缓存() as unknown as Entity, [页面A, 页面B])).toEqual(原版);
  expect(一次请求(new 本次请求缓存() as unknown as Entity, [页面A])).toEqual(一次请求(createCache(), [页面A]));
});
