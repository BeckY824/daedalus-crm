/**
 * 复查 e3ee72c（登录当场记 .owner）+ accounts.js 认领 的新条件。
 *
 * 生产里 accounts.js 的 退出() 没有任何调用方（grep desktop/main.js），指针 current.json 一旦写上就不会回到 null。
 * 于是：第一次装好 → 甲登录（_未认领 记上 .owner=甲，没重启所以还没改名）→ 甲退出 → 乙登录（壳切到乙，指针=乙）
 * → 乙退出 → 甲再登录：认领(甲) 要求 现在===null 才认领 _未认领，这时指针是乙，于是给甲建了一个**空目录**，
 * 甲录的客户永远留在 _未认领 里，界面上看就是「我的客户全没了」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require_ = createRequire(import.meta.url);
const 账号 = require_("../desktop/accounts.js");

let 根: string;
beforeEach(() => {
  根 = fs.mkdtempSync(path.join(os.tmpdir(), "r2-accounts-"));
});
afterEach(() => fs.rmSync(根, { recursive: true, force: true }));

describe("复查：_未认领 记了主之后，指针不再为 null 时主人拿不回来", () => {
  it("甲登录(未重启)→乙登录切走→甲再登录：应拿回自己在 _未认领 里录的数据", () => {
    const 未认领目录 = 账号.账号目录(根, 账号.未认领);
    fs.mkdirSync(未认领目录, { recursive: true });
    fs.writeFileSync(path.join(未认领目录, "crm.db"), "甲刚录的客户");
    // lib/desktop/cloud.ts 登录()：没主的目录，甲登录那一刻记上归属
    fs.writeFileSync(path.join(未认领目录, 账号.归属文件), "acc_甲");

    // 乙登录：壳 看凭据换没换 → 切账号 → 认领(乙)。注意生产里没人调 账号.退出()，指针此后一直是乙
    账号.认领(根, "acc_乙");
    expect(账号.读指针(根)).not.toBeNull();

    // 甲回来登录（在乙的目录上登录 → 换了账号 → 认领(甲)）
    const 甲 = 账号.认领(根, "acc_甲");
    expect(fs.existsSync(path.join(甲.目录, "crm.db"))).toBe(true); // 实际：false，甲拿到一个空目录
  });
});
