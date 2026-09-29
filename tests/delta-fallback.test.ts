/**
 * 差量的清单和 zip 主地址不通就换 feed 里的备用（2026-09-29）。
 * 国内镜像的域名没备案，阿里云按 SNI 断连接——应用里拉清单一次都没成功过，
 * 每次都「差量估算失败，退回整包」，而 GitHub 原址就躺在 feed 的「备用」里没人用。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const main = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8");

describe("差量：主地址不通换备用", () => {
  it("清单和 zip 都经 先主后备，备用取自 feed 的 备用.manifest / 备用.zip", () => {
    expect(main).toMatch(/先主后备\(新版\.manifest, 备\.manifest,/);
    expect(main).toMatch(/先主后备\(主zip, 备zip,/);
  });
  it("「不划算」那种退回整包不换备用——换了也还是不划算；只有网络上不通才换", () => {
    const 段 = main.slice(main.indexOf("async function 先主后备"), main.indexOf("async function 先主后备") + 500);
    expect(段).toContain('e?.name === "退回整包"');
  });
});
