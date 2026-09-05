/**
 * AI 产出清洗。
 *
 * 模型输出是不可信输入：枚举可能拼错、id 可能是编的、时间可能不合法。
 * 这层闸门失守的后果是脏值直接进预填表单——用户看到"选不出来"的类型，
 * 或者一条 2099 年的跟进计划。每条规则都对应一种真实的失败方式。
 */
import { describe, it, expect } from "vitest";
import { sanitizeFollowUpDraft, sanitizeBrief } from "@/lib/ai-draft";
import { stripCodeFence } from "@/lib/llm";

const ctx = { contactIds: ["c1", "c2"], opportunityIds: ["o1"] };

function draft(overrides: Record<string, unknown> = {}, followUp: Record<string, unknown> = {}) {
  return {
    followUp: { type: "PHONE", title: "", content: "聊了报价", status: "已完成", ...followUp },
    tasks: [],
    plan: null,
    followStatusSuggestion: null,
    decisionStatusSuggestion: null,
    ...overrides,
  };
}

describe("跟进速记：枚举收敛", () => {
  it("模型编出来的跟进类型收敛为 OTHER，而不是让表单出现选不出来的值", () => {
    const d = sanitizeFollowUpDraft(draft({}, { type: "WECHAT_CALL" }), ctx);
    expect(d.followUp.type).toBe("OTHER");
  });

  it("非法记录状态回落为「已完成」", () => {
    const d = sanitizeFollowUpDraft(draft({}, { status: "进行中" }), ctx);
    expect(d.followUp.status).toBe("已完成");
  });

  it("合法取值原样保留", () => {
    const d = sanitizeFollowUpDraft(draft({}, { type: "MEETING", status: "待处理" }), ctx);
    expect(d.followUp.type).toBe("MEETING");
    expect(d.followUp.status).toBe("待处理");
  });

  it("状态建议只认系统枚举，模型自创的说法置空", () => {
    const d = sanitizeFollowUpDraft(
      draft({ followStatusSuggestion: "很有意向", decisionStatusSuggestion: "对比中" }),
      ctx,
    );
    expect(d.followStatusSuggestion).toBeNull();
    expect(d.decisionStatusSuggestion).toBe("对比中");
  });
});

describe("跟进速记：id 只认真实存在的", () => {
  it("模型编造的 contactId / opportunityId 一律置空", () => {
    const d = sanitizeFollowUpDraft(draft({}, { contactId: "made-up", opportunityId: "also-fake" }), ctx);
    expect(d.followUp.contactId).toBeNull();
    expect(d.followUp.opportunityId).toBeNull();
  });

  it("列表里真实存在的 id 保留", () => {
    const d = sanitizeFollowUpDraft(draft({}, { contactId: "c2", opportunityId: "o1" }), ctx);
    expect(d.followUp.contactId).toBe("c2");
    expect(d.followUp.opportunityId).toBe("o1");
  });
});

describe("跟进速记：时长与时间", () => {
  it("负数时长置空——负时长会让累计通话时长越统计越少", () => {
    expect(sanitizeFollowUpDraft(draft({}, { durationMinutes: -10 }), ctx).followUp.durationMinutes).toBeNull();
  });

  it("超过 600 分钟的时长按算错处理置空", () => {
    expect(sanitizeFollowUpDraft(draft({}, { durationMinutes: 1200 }), ctx).followUp.durationMinutes).toBeNull();
  });

  it("正常时长四舍五入保留", () => {
    expect(sanitizeFollowUpDraft(draft({}, { durationMinutes: 19.6 }), ctx).followUp.durationMinutes).toBe(20);
  });

  it("解析不了的时间置空，由表单默认成现在", () => {
    expect(sanitizeFollowUpDraft(draft({}, { occurredAt: "下周三晚上" }), ctx).followUp.occurredAt).toBeNull();
  });

  it("十年开外的时间按模型算错处理置空", () => {
    expect(sanitizeFollowUpDraft(draft({}, { occurredAt: "2099-01-01 10:00" }), ctx).followUp.occurredAt).toBeNull();
  });

  it("合法时间转为 ISO", () => {
    const d = sanitizeFollowUpDraft(draft({}, { occurredAt: "2026-09-02 19:00" }), ctx);
    expect(d.followUp.occurredAt).not.toBeNull();
    expect(new Date(d.followUp.occurredAt!).getFullYear()).toBe(2026);
  });
});

describe("跟进速记：待办与计划", () => {
  it("空标题的待办丢弃，最多保留 5 条", () => {
    const tasks = [
      { title: "", dueAt: null },
      ...Array.from({ length: 7 }, (_, i) => ({ title: `事项${i}`, dueAt: null })),
    ];
    const d = sanitizeFollowUpDraft(draft({ tasks }), ctx);
    expect(d.tasks).toHaveLength(5);
    expect(d.tasks[0].title).toBe("事项0");
  });

  it("计划缺主题或缺时间都不成立——没时间的计划等于没计划", () => {
    expect(sanitizeFollowUpDraft(draft({ plan: { subject: "聊报价", plannedAt: "改天" } }), ctx).plan).toBeNull();
    expect(sanitizeFollowUpDraft(draft({ plan: { subject: "", plannedAt: "2026-09-02 19:00" } }), ctx).plan).toBeNull();
  });

  it("计划的沟通方式不在枚举内时回落为「电话沟通」", () => {
    const d = sanitizeFollowUpDraft(
      draft({ plan: { subject: "聊报价", plannedAt: "2026-09-02 19:00", method: "飞书语音" } }),
      ctx,
    );
    expect(d.plan?.method).toBe("电话沟通");
  });
});

describe("跟进速记：整体失败要如实抛出", () => {
  it("连沟通内容都没解析出来时抛错，不能假装成功", () => {
    expect(() => sanitizeFollowUpDraft(draft({}, { content: "" }), ctx)).toThrow();
    expect(() => sanitizeFollowUpDraft(null, ctx)).toThrow();
  });
});

describe("临战简报", () => {
  it("故事线缺失即失败", () => {
    expect(() => sanitizeBrief({ current: "卡在报价" })).toThrow();
  });

  it("要点与风险只收字符串、去空白、限条数", () => {
    const b = sanitizeBrief({
      story: "转介绍来的，聊过三次",
      current: "卡在家里预算",
      talkingPoints: ["  谈分期  ", 42, "", "约试听", "a", "b", "c", "d"],
      risks: ["竞品在压价"],
    });
    expect(b.talkingPoints).toEqual(["谈分期", "约试听", "a", "b", "c"]);
    expect(b.risks).toEqual(["竞品在压价"]);
  });
});

describe("代码围栏剥离", () => {
  it("```json 围栏能剥掉", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("没有围栏的内容原样返回", () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});
