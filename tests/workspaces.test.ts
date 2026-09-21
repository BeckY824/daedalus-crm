/**
 * 工作区的试用与订阅判定。
 *
 * computeWritable 是托管版唯一决定「这个团队现在还能不能写数据」的地方，
 * 判错的后果是两个方向的事故：该拦的没拦（白用），或者付了钱被拦住（更糟）。
 * 所以边界要逐个钉死。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeWritable, daysLeft, slugify, 长期有效, TRIAL_DAYS } from "@/lib/tenant/workspaces";

const 天 = 86_400_000;
const 此刻 = new Date("2026-09-13T10:00:00Z");
const 相对 = (d: number) => new Date(此刻.getTime() + d * 天);

describe("能不能写", () => {
  it("试用期内可写", () => {
    expect(computeWritable({ status: "TRIAL", trialEndsAt: 相对(3), paidUntil: null }, 此刻)).toBe(true);
  });

  it("试用到期后只读", () => {
    expect(computeWritable({ status: "TRIAL", trialEndsAt: 相对(-1), paidUntil: null }, 此刻)).toBe(false);
  });

  it("付费有效期内可写，哪怕试用早就过了", () => {
    expect(computeWritable({ status: "ACTIVE", trialEndsAt: 相对(-30), paidUntil: 相对(300) }, 此刻)).toBe(true);
  });

  it("付费过期后只读——标着 ACTIVE 也不行，以日期为准", () => {
    expect(computeWritable({ status: "ACTIVE", trialEndsAt: 相对(-30), paidUntil: 相对(-1) }, 此刻)).toBe(false);
  });

  it("被停用一律只读，哪怕还在付费期内", () => {
    expect(computeWritable({ status: "SUSPENDED", trialEndsAt: 相对(9), paidUntil: 相对(99) }, 此刻)).toBe(false);
  });

  it("试用最后一刻仍可写，过一秒就不行", () => {
    const 刚好 = new Date(此刻.getTime() + 1000);
    expect(computeWritable({ status: "TRIAL", trialEndsAt: 刚好, paidUntil: null }, 此刻)).toBe(true);
    expect(computeWritable({ status: "TRIAL", trialEndsAt: 此刻, paidUntil: null }, 此刻)).toBe(false);
  });
});

describe("还剩几天", () => {
  it("试用按到期日算", () => {
    expect(daysLeft({ trialEndsAt: 相对(3), paidUntil: null }, 此刻)).toBe(3);
  });

  it("付费比试用晚时以付费为准", () => {
    expect(daysLeft({ trialEndsAt: 相对(2), paidUntil: 相对(40) }, 此刻)).toBe(40);
  });

  it("过期显示 0，不出负数", () => {
    expect(daysLeft({ trialEndsAt: 相对(-5), paidUntil: null }, 此刻)).toBe(0);
  });

  it("试用天数按拍板的 7 天", () => {
    expect(TRIAL_DAYS).toBe(7);
  });
});

describe("长期有效：共享区那个 26764 天", () => {
  /**
   * 共享工作区的 trialEndsAt 设在 2100 年（scripts/seed-shared.ts 的「永远可写」），
   * daysLeft 于是算出 26764。运营台原来把它当真报出来——一个每天变一次、
   * 永远没有意义的数，看着像 bug（2026-09-21 用户就是这么发现的）。
   */
  it("十年以上算不过期，十年以内照报天数", () => {
    expect(长期有效(26764)).toBe(true);
    expect(长期有效(3651)).toBe(true);
    expect(长期有效(3650)).toBe(false);
    expect(长期有效(365)).toBe(false);
    expect(长期有效(7)).toBe(false);
    expect(长期有效(0)).toBe(false);
  });

  it("2100 年那个日子算出来的天数确实落在「不过期」那一侧", () => {
    const 天 = daysLeft({ trialEndsAt: new Date("2100-01-01T00:00:00Z"), paidUntil: null });
    expect(天).toBeGreaterThan(20000);
    expect(长期有效(天)).toBe(true);
  });

  it("运营台不再直接把天数写在共享区那一行上", () => {
    const view = fs.readFileSync(path.resolve(__dirname, "../src/app/admin/AdminView.tsx"), "utf8");
    const page = fs.readFileSync(path.resolve(__dirname, "../src/app/admin/page.tsx"), "utf8");
    // 判定在服务端做（page.tsx），视图只读那个布尔——AdminView 是 "use client"，
    // 而 lib/tenant/workspaces.ts 带着 node:fs 和 prisma，一 import 就把服务端代码拖进浏览器
    expect(page).toContain("长期有效(daysLeft(");
    // 注释里提它没关系，import 它才要命
    expect(view).not.toMatch(/from "@\/lib\/tenant\/workspaces"/);
    expect(view).toContain("试用 · 不过期");
  });
});

describe("工作区标识", () => {
  it("纯中文名也能出合法 slug——不能因为没有拉丁字母就建不出工作区", () => {
    const s = slugify("启明教育");
    expect(s).toMatch(/^[a-z0-9-]+$/);
    expect(s.length).toBeGreaterThan(2);
  });

  it("同名两次不会撞——slug 同时是文件名，撞了就是两个团队共用一个库", () => {
    expect(slugify("Acme")).not.toBe(slugify("Acme"));
  });

  it("空格与符号不会带进文件名", () => {
    expect(slugify("Acme Corp / 北京 分部!")).toMatch(/^[a-z0-9-]+$/);
  });
});
