/**
 * 首页那两个「下载次数」的口径。
 *
 * 2026-09-25 起：**累计**，而且官网（国内节点）和 GitHub **分开报**——用户定的。
 * 之前是「当前这一版、两边相加」一个数。这些规则**错了都不会报错**，
 * 只会让首页安静地说一个假数——所以钉在这儿。
 */
import { describe, it, expect } from "vitest";
import { 镜像累计, GitHub累计 } from "@/lib/download-count";

describe("镜像累计（官网下载数）", () => {
  it("所有版本加起来，不是只看当前这一版", () => {
    expect(镜像累计({ 按版本: { "0.45.0": 2, "0.46.1": 6, "0.46.3": 1 } })).toBe(9);
  });

  it("一版都还没人下（没有任何键）是 0，不是取不到", () => {
    expect(镜像累计({ 按版本: {} })).toBe(0);
  });

  it("整份结构不对（文件在但不是我们写的那种）就是取不到，不能当 0", () => {
    expect(镜像累计({ 别的字段: 1 })).toBeUndefined();
    expect(镜像累计("一段字符串")).toBeUndefined();
    expect(镜像累计(null)).toBeUndefined();
  });

  it("有一项不是正常的数，整个就不可信——少数一项的累计也是假数", () => {
    expect(镜像累计({ 按版本: { "0.45.0": 2, "0.46.1": "6" } })).toBeUndefined();
    expect(镜像累计({ 按版本: { "0.45.0": -1 } })).toBeUndefined();
    expect(镜像累计({ 按版本: { "0.45.0": Number.NaN } })).toBeUndefined();
  });
});

describe("GitHub累计（GitHub下载数）", () => {
  const rel = (...assets: { name: string; download_count: unknown }[]) => ({ assets });

  it("所有 Release 里的 dmg 加起来，含滚动的 desktop-updates", () => {
    const 全部 = [
      rel({ name: "Daedalus.CRM-0.46.0-arm64.dmg", download_count: 5 }),
      rel({ name: "Daedalus.CRM-0.46.1-arm64.dmg", download_count: 3 }, { name: "Daedalus.CRM-0.46.3-arm64.dmg", download_count: 2 }),
    ];
    expect(GitHub累计(全部)).toBe(10);
  });

  it("只数 dmg：app.zip 和清单是应用内更新用的，不算「有人下载了桌面端」", () => {
    const 全部 = [
      rel(
        { name: "Daedalus.CRM-0.46.3-arm64.dmg", download_count: 2 },
        { name: "Daedalus.CRM-0.46.3-arm64.app.zip", download_count: 40 },
        { name: "Daedalus.CRM-0.46.3-arm64.manifest.json.gz", download_count: 90 },
      ),
    ];
    expect(GitHub累计(全部)).toBe(2);
  });

  it("没挂任何资产的 Release（只发镜像的版本）不影响", () => {
    expect(GitHub累计([{ assets: [] }, { tag_name: "v0.1.0" }, rel({ name: "a.dmg", download_count: 1 })])).toBe(1);
  });

  it("不是列表、或某个 dmg 的计数不是正常的数，就是取不到", () => {
    expect(GitHub累计({ message: "rate limited" })).toBeUndefined();
    expect(GitHub累计([rel({ name: "a.dmg", download_count: "3" })])).toBeUndefined();
  });
});
