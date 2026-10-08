import StatePage from "@/components/StatePage";
import { getBusiness } from "@/lib/business";

/**
 * 应用内的 404。和出错页、空状态同一套外观（components/StatePage）：
 * 说清发生了什么、为什么、接下来做什么，再给一个能点的地方。
 */
export default async function NotFound() {
  const b = await getBusiness();
  return (
    <StatePage
      标题="没有找到这条记录"
      说明={`这条记录可能已删除、暂不可见，或链接中的编号不正确。回${b.customer}列表按名字搜一下。`}
      动作={{ label: `回${b.customer}列表`, href: "/customers" }}
      次动作={{ label: "回首页", href: "/dashboard" }}
    />
  );
}
