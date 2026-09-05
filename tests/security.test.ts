/**
 * 安全组：登录限流、错误信息不外泄。
 *
 * 存储型 XSS 放在 E2E 里测（e2e/security.spec.ts），
 * 因为要验的是「浏览器会不会真的执行」，在 Node 里断言字符串没有意义。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  检查限流, 记一次失败, 清除限流, 重置限流, 解析来源IP, 当前条数,
  阈值, IP阈值, 冷却毫秒, 最多条数,
} from "@/lib/rate-limit";
import { 决定错误展示 } from "@/lib/error-display";

beforeEach(() => 重置限流());

describe("登录失败限流", () => {
  it("没失败过的直接放行", () => {
    expect(检查限流("u:someone")).toBeNull();
  });

  it(`连续失败 ${阈值} 次后进入冷却，并告知还要等多久`, () => {
    for (let i = 0; i < 阈值 - 1; i++) 记一次失败("u:a");
    expect(检查限流("u:a"), `第 ${阈值 - 1} 次失败后不该拦`).toBeNull();

    记一次失败("u:a");
    const 还要等 = 检查限流("u:a");
    expect(还要等).not.toBeNull();
    expect(还要等!).toBeGreaterThan(0);
    expect(还要等!).toBeLessThanOrEqual(冷却毫秒 / 1000);
  });

  it("冷却时间一到自动恢复，不需要人工解锁", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 阈值; i++) 记一次失败("u:b", t0);
    expect(检查限流("u:b", t0 + 1000)).not.toBeNull();
    // 冷却结束
    expect(检查限流("u:b", t0 + 冷却毫秒 + 1)).toBeNull();
  });

  it("登录成功立即清零，不让上次的失败影响下次", () => {
    for (let i = 0; i < 阈值; i++) 记一次失败("u:c");
    expect(检查限流("u:c")).not.toBeNull();
    清除限流("u:c");
    expect(检查限流("u:c")).toBeNull();
  });

  it("账号与 IP 各记各的，互不牵连", () => {
    for (let i = 0; i < 阈值; i++) 记一次失败("u:张三");
    expect(检查限流("u:张三")).not.toBeNull();
    // 同一个 IP 上的另一个账号不该被连坐
    expect(检查限流("u:李四")).toBeNull();
    expect(检查限流("ip:1.2.3.4")).toBeNull();
  });

  it("刻意不做永久锁定：等待期结束就能再试", () => {
    /**
     * 锁定看起来更严，但任何人拿别人的用户名连试几次就能把同事锁在系统外面。
     * 这套系统只有几个人用，一个人被锁住就是一个人干不了活。
     */
    const t0 = 2_000_000;
    for (let i = 0; i < 阈值 * 3; i++) 记一次失败("u:d", t0);
    // 无论失败多少次，等待时间都不会超过一个冷却周期
    const 还要等 = 检查限流("u:d", t0);
    expect(还要等!).toBeLessThanOrEqual(冷却毫秒 / 1000);
  });
});

describe("IP 档的阈值必须比账号档松得多", () => {
  /**
   * 整个办公室共用一个出口 IP。两档定成一样的话，
   * 一个同事打错 5 次密码，全公司 5 分钟登不上——
   * 这比它想防的撞库更容易发生，也更难排查。
   * 这个坑是在 E2E 全量跑时撞出来的：一条用例把某个账号试错 5 次，
   * 后面所有用例的登录全被同一个 IP 桶挡住了。
   */
  it("IP 档阈值明显高于账号档", () => {
    expect(IP阈值).toBeGreaterThan(阈值 * 4);
  });

  it("按账号试错到上限时，同 IP 的其他账号不受影响", () => {
    const ip = "ip:203.0.113.7";
    for (let i = 0; i < 阈值; i++) {
      记一次失败("u:张三", Date.now(), 阈值);
      记一次失败(ip, Date.now(), IP阈值);
    }
    expect(检查限流("u:张三"), "本人应当被拦").not.toBeNull();
    expect(检查限流(ip), "同 IP 的其他人不该被连坐").toBeNull();
  });

  it("同一 IP 上大量试错（脚本行为）仍然会被拦", () => {
    const ip = "ip:203.0.113.8";
    for (let i = 0; i < IP阈值; i++) 记一次失败(ip, Date.now(), IP阈值);
    expect(检查限流(ip)).not.toBeNull();
  });
});

describe("来源 IP 必须取不可伪造的那一段", () => {
  /**
   * X-Forwarded-For 是一条链：`客户端自称的, 上游代理看到的, ..., 最近一跳看到的`。
   * 早先取的是第一段，而那一段客户端自己就能写——每次换个假 IP 就换一个桶，
   * IP 档的上限形同虚设，还能拿假 IP 把内存里的表撑大。
   */
  it("多段时取最后一段（反代自己拼上去的那段）", () => {
    expect(解析来源IP("1.2.3.4, 10.0.0.1, 172.18.0.5")).toBe("172.18.0.5");
  });

  it("客户端伪造前缀改变不了结果", () => {
    const 真实 = 解析来源IP("172.18.0.5");
    expect(解析来源IP("6.6.6.6, 172.18.0.5"), "伪造一段就换了桶").toBe(真实);
    expect(解析来源IP("7.7.7.7, 8.8.8.8, 172.18.0.5")).toBe(真实);
  });

  it("没有这个头时返回 null，只按账号限流", () => {
    expect(解析来源IP(null)).toBeNull();
    expect(解析来源IP("")).toBeNull();
    expect(解析来源IP("   ")).toBeNull();
    expect(解析来源IP(",,")).toBeNull();
  });

  it("多余空格不影响", () => {
    expect(解析来源IP("  1.2.3.4 ,  172.18.0.5  ")).toBe("172.18.0.5");
  });
});

describe("限流表不能被撑到无限大", () => {
  it("超过上限后条数被压回去，且不影响正常限流", () => {
    重置限流();
    // 模拟被人拿大量不同 key 打
    for (let i = 0; i < 最多条数 + 500; i++) 记一次失败(`u:攻击${i}`);
    expect(当前条数(), "表被撑到了上限之上").toBeLessThanOrEqual(最多条数);

    // 挤爆之后，新来的账号仍然能被正常限流
    for (let i = 0; i < 阈值; i++) 记一次失败("u:正常用户");
    expect(检查限流("u:正常用户")).not.toBeNull();
  });
});

describe("错误页不外泄内部信息", () => {
  it("生产环境不显示 error.message，只给可追溯的编号", () => {
    const 展示 = 决定错误展示(
      { message: "Invalid `prisma.customer.findMany()` invocation: 表 main.Customer 不存在", digest: "abc123" },
      false,
    );
    expect(展示.类型).toBe("编号");
    expect(JSON.stringify(展示)).not.toContain("prisma");
    expect(JSON.stringify(展示)).not.toContain("Customer");
    if (展示.类型 === "编号") expect(展示.digest).toBe("abc123");
  });

  it("没有 digest 时也不能退回去显示原文", () => {
    const 展示 = 决定错误展示({ message: "/app/src/lib/prisma.ts:42 ENOENT" }, false);
    expect(展示.类型).toBe("编号");
    expect(JSON.stringify(展示)).not.toContain("/app/src");
  });

  it("开发环境仍显示原文，否则调试要一直翻服务端日志", () => {
    const 展示 = 决定错误展示({ message: "具体报错" }, true);
    expect(展示).toEqual({ 类型: "原文", 文本: "具体报错" });
  });

  it("会话过期走单独分支，给的是「重新登录」而不是报错", () => {
    expect(决定错误展示({ message: "UNAUTHORIZED" }, false).类型).toBe("未登录");
    expect(决定错误展示({ message: "UNAUTHORIZED" }, true).类型).toBe("未登录");
  });
});
