/**
 * 最终回答的开头清洗器。
 *
 * 线上真实出现过：agent 的最终回答以 `{"final":true}` 开头，原样流到了用户屏幕上。
 * 决策步与回答步共用一段全是 JSON 的对话，模型被格式带偏，提示词挡不住，
 * 所以在流式出口兜底。这里锁住两件事：控制信令要剥干净，正文一个字都不能少。
 */
import { describe, it, expect } from "vitest";
import { 开头清洗器 } from "@/lib/agent/run";

/** 把一段文本按任意块大小喂进去，模拟流式 token */
function 流(text: string, 块 = 3) {
  const 出: string[] = [];
  const c = 开头清洗器((s) => 出.push(s));
  for (let i = 0; i < text.length; i += 块) c.推入(text.slice(i, i + 块));
  return { emitted: 出.join(""), text: c.文本() };
}

describe("开头清洗器", () => {
  it("剥掉开头的 {\"final\":true} 只留正文", () => {
    const r = 流('{"final":true}\n\n系统里有两位陈泽宇，先确认一下：');
    expect(r.emitted).toBe("系统里有两位陈泽宇，先确认一下：");
    expect(r.text).toBe(r.emitted);
  });

  it("带 ```json 代码围栏的也剥", () => {
    const r = 流('```json\n{"final": true}\n```\n当前学员共 38 人。');
    expect(r.emitted).toBe("当前学员共 38 人。");
  });

  it("正常回答一个字都不动", () => {
    const 正文 = "当前学员共 38 人：\n\n- 跟进中：11 人\n- 已签约：9 人";
    expect(流(正文).emitted).toBe(正文);
  });

  it("正文里出现花括号不受影响（只看开头）", () => {
    const 正文 = "可以这样写：{ name: 张三 }，注意大小写。";
    expect(流(正文).emitted).toBe(正文);
  });

  it("答案被包进 JSON 字段时，取出最长的字符串当正文", () => {
    const r = 流('{"final":true,"answer":"这个月张三签得最多，合计 4 单。"}');
    expect(r.emitted).toBe("这个月张三签得最多，合计 4 单。");
  });

  it("开头是花括号但迟迟不闭合时原样放行，绝不吞正文", () => {
    const 正文 = "{" + "正".repeat(500);
    expect(流(正文).emitted).toBe(正文);
  });

  it("逐字符喂入与整段喂入结果一致", () => {
    const 原 = '{"final":true}\n答案在这里。';
    expect(流(原, 1).emitted).toBe(流(原, 999).emitted);
  });

  it("开头一堆空白也能正确判断", () => {
    expect(流('\n\n  {"final":true}\n真正的回答').emitted).toBe("真正的回答");
  });
});

describe("收尾", () => {
  it("流结束时还攒在缓冲里的开头要吐出来，不能丢字", () => {
    const 出: string[] = [];
    const c = 开头清洗器((s) => 出.push(s));
    c.推入('{"final":tr'); // 半截 JSON，流就断了
    expect(出.join("")).toBe("");
    c.收尾();
    expect(出.join("")).toBe('{"final":tr');
  });

  it("正常剥完之后收尾是空操作", () => {
    const 出: string[] = [];
    const c = 开头清洗器((s) => 出.push(s));
    c.推入('{"final":true}\n正文');
    c.收尾();
    c.收尾();
    expect(出.join("")).toBe("正文");
  });
});
