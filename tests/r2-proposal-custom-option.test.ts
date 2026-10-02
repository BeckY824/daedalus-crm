/**
 * 复查 fd7f1e6「能选也能填」：AI 建议卡上的「方式」「来源」改成了 OptionInput（能填列表外的字），
 * 线索表单、计划表单的服务端也不再拦列表外的值——但卡片确认走 applyProposal → buildProposal 重新校验，
 * 那里还是 pickEnum（只认列表内），人在卡上填的自定义值点「确认」只会得到一句
 * 「method 必须是：电话沟通/…」「source 必须是：…」，存不进去。
 */
import { describe, it, expect } from "vitest";
import { buildProposal } from "@/lib/agent/proposals";
import { dayjs } from "@/lib/utils";

const 客户 = { id: "c1", name: "陈立" };
const 业务 = {
  sources: ["微信", "小红书", "其他"],
  fields: { school: "公司", grade: "职位", major: "行业" },
  grades: ["其他"],
};

describe("复查：卡片上自填的方式 / 来源，确认时被重新校验拒掉", () => {
  it("计划卡：方式填「视频号直播」应能确认", () => {
    const r = buildProposal("p1", "add_plan", 客户, { subject: "聊报价", plannedAt: dayjs().add(1, "day").format("YYYY-MM-DD HH:mm"), method: "视频号直播", reason: "他说下周有空" }, 业务);
    expect(r.ok ? "ok" : r.error).toBe("ok"); // 实际：method 必须是：电话沟通/…
  });
  it("线索卡：来源填「老板朋友圈」应能确认", () => {
    const r = buildProposal("p1", "add_lead", 客户, { name: "李雷", source: "老板朋友圈", reason: "聊天里提到" }, 业务);
    expect(r.ok ? "ok" : r.error).toBe("ok"); // 实际：source 必须是：微信/小红书/其他
  });
});
