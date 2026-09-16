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
      标题="这条记录不在了"
      说明={`地址是对的，但它指向的东西已经不在库里——多半是被人删掉了，也可能是链接里的编号抄错了一位。回${b.customer}列表按名字搜一下最快。`}
      动作={{ label: `回${b.customer}列表`, href: "/customers" }}
      次动作={{ label: "回首页", href: "/dashboard" }}
    />
  );
}
