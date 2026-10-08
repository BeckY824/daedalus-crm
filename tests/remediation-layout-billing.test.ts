import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ hosted: true, queries: [] as string[], workspaces: [{ id: "qa-ws", name: "QA", slug: "qa-private", role: "OWNER" }] }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => ({ id: "qa", name: "QA", role: "ADMIN", accountId: "qa-account", workspaceId: "qa-ws" }) }));
vi.mock("@/lib/prisma", () => ({ prisma: { customer: { count: async () => {state.queries.push("customer");return 1} }, opportunity: { count: async () => {state.queries.push("opportunity");return 1} } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/favorites", () => ({ 读收藏: async () => {state.queries.push("favorites");return []} }));
vi.mock("@/lib/reminders-db", () => ({ 取提醒项: async () => [], 取订单提醒项: async () => [] }));
vi.mock("@/lib/business", () => ({ getBusiness: async () => ({}) }));
vi.mock("@/lib/desktop/cloud", () => ({ 本地模式: () => false, 归属对不上: () => false, 读: () => null }));
vi.mock("@/lib/tenant/context", () => ({ multiTenant: () => state.hosted }));
vi.mock("@/lib/tenant/workspace-access", () => ({ accessibleWorkspacesFor: async () => state.workspaces }));
vi.mock("@/lib/llm", () => ({ llmEnabled: async () => false, listModelOptions: async () => [] }));
vi.mock("@/lib/ai-meter", () => ({ 读AI计次: async () => ({}), 不计次: {} }));
vi.mock("@/lib/phone-dedupe", () => ({ 记下分机留存起: async () => {} }));
vi.mock("@/components/AppShell", () => ({ default: () => null }));
vi.mock("@/components/AiCost", () => ({ AiMeterProvider: () => null }));
vi.mock("@/lib/business-client", () => ({ BusinessProvider: () => null }));
import AppLayout from "@/app/(app)/layout";
afterEach(() => { vi.unstubAllEnvs(); });
it.each([
  [true, "OWNER", "qa-private", true],
  [true, "MEMBER", "qa-private", false],
  [true, "ADMIN", "qa-private", false],
  [true, "OWNER", "qa-shared", false],
  [false, "OWNER", "qa-private", false],
])("H-098 真实layout按hosted=%s/role=%s/slug=%s决定订阅入口=%s", async (hosted, role, slug, billing) => {
  state.hosted = hosted; state.workspaces = [{ id: "qa-ws", name: "QA", slug, role }]; vi.stubEnv("SHARED_WORKSPACE", "qa-shared");
  const layout = await AppLayout({ children: null, pane: null, modal: null });
  expect(layout.props.timeZone).toBe(hosted ? "Asia/Shanghai" : null);
  expect(layout.props.children.props.children[0].props.workspace).toMatchObject({ name: "QA", billing });
});

it.each([true,false])("L-112 hosted=%s 每次布局只加载一次实际用于侧栏的计数与收藏",async hosted=>{
 state.hosted=hosted;state.queries=[];const layout=await AppLayout({children:null,pane:null,modal:null});
 expect(state.queries.sort()).toEqual(["customer","favorites","opportunity"]);
 const props=layout.props.children.props.children[0].props;
 expect(props.计数).toMatchObject({"/customers":1,"/opportunities":1});expect(props.收藏).toEqual([]);
});
