"use client";

import { useRouter } from "next/navigation";
import { Segmented } from "antd";
import { PageHead } from "@/components/ui";
import { 视图们, type 视图 } from "./views";

/**
 * 「数据」页的壳：标题 + 三视图切换。
 *
 * **这儿原来还有一个「问一个数」的输入框**（reports/AskData），2026-09-19 撤掉。
 * 0.38 之后右边那条 AI 面板在每一页都常驻着，这一页于是同屏摆了两个长得一样的框：
 * 正文那个只问数字、出图表，面板那个是完整的 agent。
 * 两件事确实不同，但**人分不出来**——只会以为这一页坏了一个，或者不知道该用哪个。
 * 少一个框不丢任何能力：数字类问题面板照样答（走的是同一条 query_metric）。
 *
 * 连带 AskData.tsx / AskDataResult.tsx 一起删了。服务端那条 `mode: "home"`
 * （api/ai/stream → dashboard/ask.ts 的 askHome）暂时留着没人调，记在交接里另扫。
 */
export default function DataShell({
  view,
  children,
}: {
  view: 视图;
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
      {children}
    </>
  );
}
