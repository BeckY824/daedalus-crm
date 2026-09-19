/**
 * 全局 AI 面板带的那句上下文。
 *
 * 钉两头：该带的带上（列表页的筛选条件是问题的一部分——在筛着"已签约"的客户列表上问
 * "这些人谁快签了"，不带筛选就是另一个问题），不该带的不带（首页、设置页没有"范围"这回事，
 * 硬造一句只会让模型多想一轮）。
 *
 * 这是第五份「必须和别处一致的清单」：每条一级路由都要有说法，
 * 漏了的话那一页的面板会安静地失去上下文——不报错，只是答得不对题。
 */
import { describe, it, expect } from "vitest";
import { 认页面 } from "@/lib/ai-context-page";

const 参数 = (s: string) => new URLSearchParams(s);

describe("认页面", () => {
  it("列表页：带页面名", () => {
    expect(认页面("/customers", null)?.标签).toBe("客户");
    expect(认页面("/channels", null)?.提示).toContain("渠道列表");
  });

  it("列表页带筛选：筛选条件是问题的一部分", () => {
    const r = 认页面("/customers", 参数("followStatus=已签约"));
    expect(r?.标签).toBe("客户，筛了跟进状态 已签约");
    expect(r?.提示).toContain("已签约");
    expect(r?.提示).toContain("范围");
  });

  it("多个筛选一起带", () => {
    const r = 认页面("/opportunities", 参数("stage=方案报价&owner=李四"));
    expect(r?.标签).toContain("阶段 方案报价");
    expect(r?.标签).toContain("负责人 李四");
  });

  it("客户详情：解得开「他」", () => {
    const r = 认页面("/customers/abc123", null, "张三");
    expect(r?.标签).toBe("客户 · 张三");
    expect(r?.提示).toContain("「他」");
    expect(r?.提示).toContain("张三");
  });

  it("详情页没拿到名字就不瞎编", () => {
    expect(认页面("/customers/abc123", null)).toBeNull();
  });

  it("首页和设置没有「范围」这回事，不硬造", () => {
    expect(认页面("/dashboard", null)).toBeNull();
    expect(认页面("/settings", null)).toBeNull();
    expect(认页面("/billing", null)).toBeNull();
  });

  it("首页带了筛选参数也不算——?c= 是对话 id，不是筛选", () => {
    expect(认页面("/dashboard", 参数("c=xyz"))).toBeNull();
  });

  it("认不出来的路径返回 null，不抛", () => {
    expect(认页面("/whatever", null)).toBeNull();
    expect(认页面("/", null)).toBeNull();
  });

  /**
   * 每一页都要指名「这一页的数据用哪个工具查」。
   *
   * 2026-09-19 的线索页事故：模型连着四次 `search_customers()` 空参数，
   * 而 Steven 在 Lead 表里。`list_leads` 的工具说明里**早就**写着「别用 search_customers 找线索」，
   * 不顶用——十一个工具的说明一起摆着，小模型按名字的字面意思挑。
   * 人站在哪一页是我们确定知道的，必须兑换成一句指名道姓的话。
   *
   * 漏一页的后果和上面那条一样：不报错，只是那一页永远选错工具。
   */
  it("每一页都指名了该用哪个工具", () => {
    const 页 = ["/overview", "/reports", "/leads", "/customers", "/channels", "/contacts", "/opportunities", "/opportunities/pipeline", "/follow-ups", "/follow-ups/plans"];
    // 工具名后面允许跟一段中文限定（「query_records（表=联系人）」），别把字符类写死成 ASCII
    const 漏了 = 页.filter((p) => !/这一页的数据先用 \*\*[a-z_]+[^*]*\*\* 查/.test(认页面(p, null)?.提示 ?? ""));
    expect(漏了, `这些页面没说该用哪个工具：${漏了.join("、")}`).toEqual([]);
  });

  it("线索页指的是 list_leads，不是 search_customers", () => {
    const r = 认页面("/leads", null);
    expect(r?.提示).toContain("list_leads");
    // 「两张表」这句是这条 bug 的正解，不能被顺手删掉
    expect(r?.提示).toContain("两张不同的表");
    expect(r?.提示).toContain("search_customers 一条也查不到");
  });

  /**
   * **指路是起点，不是死路。**
   *
   * 2026-09-19 报上来的：在数据页问「新增的客户是谁？」答不出来。
   * 那一页指的是 query_metric，而它返回的是 `{metric, rows:[{label,value}]}`——
   * 只有聚合数字、没有姓名，「是谁」天生答不了；而指路那句原话还写着
   * 「别挑别的工具试」，把出路也堵死了。那句话本来是为线索页写的
   * （要挡「拿 search_customers 查线索表」），一刀切到每一页就成了这样。
   */
  it("每一页都写明「它答不了的就换工具」，不许堵死", () => {
    const 页 = ["/overview", "/reports", "/leads", "/customers", "/channels", "/contacts", "/opportunities", "/follow-ups", "/follow-ups/plans"];
    const 堵死的 = 页.filter((p) => !/换一个合适的工具/.test(认页面(p, null)?.提示 ?? ""));
    expect(堵死的, `这些页面没给出路：${堵死的.join("、")}`).toEqual([]);
    // 那句被删掉的绝对化措辞不许回来
    for (const p of 页) expect(认页面(p, null)?.提示, `${p} 又写上「别挑别的工具试」了`).not.toContain("别挑别的工具试");
  });

  /**
   * 默认工具给不出名单的那几页，必须写明「问『是谁』该换谁」。
   * 这是第八份「必须一致的清单」：漏了不报错，只是那一页问「是谁」永远答不出来。
   */
  it("只给数 / 只给我的 / 必须带关键词的那几页，都写明了换谁", () => {
    const 要补的: [string, string][] = [
      ["/overview", "search_customers"],
      ["/reports", "query_records"],
      ["/follow-ups", "query_records"],
      ["/follow-ups/plans", "query_records"],
    ];
    for (const [路, 该换成] of 要补的) {
      const 提示 = 认页面(路, null)?.提示 ?? "";
      expect(提示, `${路} 没写默认工具答不了什么`).toMatch(/只给数|只给「我的」|必须给关键词/);
      expect(提示, `${路} 没写该换成 ${该换成}`).toContain(该换成);
    }
  });

  /** 0.39 起联系人终于有对应的工具了（Contact 表原来一个工具都不管） */
  it("联系人页指的是 query_records，不再是「先 search_customers 再 get_customer」", () => {
    const r = 认页面("/contacts", null);
    expect(r?.提示).toContain("query_records");
    expect(r?.提示).toContain("search_customers 查不到他们");
  });

  it("客户详情页把姓名塞进 get_customer 的参数里", () => {
    expect(认页面("/customers/abc123", null, "张三")?.提示).toContain('get_customer** 查（参数 name="张三"）');
  });

  /** 落库时拿它当对话标题的前缀，所以不能带筛选条件——那是给人看的标签才有的 */
  it("名 是干净的页面名，标签才带筛选", () => {
    const r = 认页面("/customers", 参数("followStatus=已签约"));
    expect(r?.名).toBe("客户");
    expect(r?.标签).toBe("客户，筛了跟进状态 已签约");
  });

  /**
   * 左栏里有的路由，这张表里必须都有——漏一条的后果是那一页的面板安静地失去上下文：
   * 不报错，只是答得不对题。和打包白名单、工具 schema 是同一类洞。
   */
  it("左栏每一项都有说法", async () => {
    const shell = (await import("node:fs")).readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
    const 路径 = [...new Set([...shell.matchAll(/key: "(\/[a-z-]+)", icon:/g)].map((m) => m[1]))];
    expect(路径.length).toBeGreaterThanOrEqual(8);
    const 漏了 = 路径.filter((p) => !认页面(p, 参数("followStatus=x")) && !认页面(p, null));
    expect(漏了, `这些页面没有上下文说法：${漏了.join("、")}`).toEqual([]);
  });
});
