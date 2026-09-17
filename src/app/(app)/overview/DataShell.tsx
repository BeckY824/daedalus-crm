"use client";

import { useRouter } from "next/navigation";
import { Segmented } from "antd";
import { PageHead } from "@/components/ui";
import AskData from "../reports/AskData";
import { 视图们, type 视图 } from "./views";

/**
 * 「数据」页的壳：标题、三视图切换、问数据的输入框。
 *
 * 问数据这个框和首页那个是**同一个组件**（components/AskBox）。
 * 原来两处各写一个：一个是带命令和建议卡的对话框，一个是 antd 的搜索框，
 * 长得不一样、快捷键不一样、答案的样子也不一样——人会以为它们是两种能力。
 */
export default function DataShell({
  view,
  aiEnabled,
  children,
}: {
  view: 视图;
  aiEnabled: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <>
      <PageHead title="数据" subtitle="业务现状与签约复盘" />
      {/* 三视图切换在页头下面、内容上面，靠左（设计稿 08/DATA·NOW）。
          它不是页头上的一个动作，它是「下面这一屏说的是哪一段时间」——
          放在右上角时，人看完标题往下走，会先撞上数字再回头找它 */}
      <Segmented
        style={{ marginBottom: 16 }}
        value={view}
        onChange={(v) => router.push(`/overview?view=${encodeURIComponent(String(v))}`)}
        options={[...视图们]}
      />
      {aiEnabled && <AskData />}
      {children}
    </>
  );
}
