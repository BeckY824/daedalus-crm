/**
 * 一个云端账号一份数据（desktop/accounts.js）。
 *
 * 0.39.2 之前只有一份：`<数据根>/data/crm.db` 跟着 **macOS 账号**走，不跟云端账号走。
 * 同一个 macOS 登录下 A 退出、B 登录，B 打开的就是 A 那个库——客户、跟进、
 * AI 对话全看得见。这里钉的是三件事：
 *
 *   1. **分得开**：两个账号两个目录，互相看不到
 *   2. **升级不丢**：老的那一份 data/ 认领给它本来的主人，只改名不复制不删除
 *   3. **退出不删**：退出登录只清指针，再登录回来东西还在
 *
 * 拦不住的那一层（同一个 macOS 登录下拿 SQLite 工具直接开对方的文件）不在这儿钉，
 * 那是 OS 的事，界面上如实写着。
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
  根 = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-test-"));
});
afterEach(() => fs.rmSync(根, { recursive: true, force: true }));

/** 造一份「升级前」的数据目录：data/crm.db，可选带 .cloud.json */
function 造旧数据(accountId?: string) {
  const d = path.join(根, "data");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "crm.db"), "这是甲的客户数据");
  if (accountId) fs.writeFileSync(path.join(d, ".cloud.json"), JSON.stringify({ token: "t", accountId }));
  return d;
}

/** 迁移时怎么从 .cloud.json 里读账号 id。壳里由 cloud.js 提供，这里给个等价的 */
const 取账号id = (f: string) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")).accountId ?? null;
  } catch {
    return null;
  }
};

describe("key", () => {
  it("同一个账号总是同一个目录名，不同账号不撞", () => {
    expect(账号.key("acc_1")).toBe(账号.key("acc_1"));
    expect(账号.key("acc_1")).not.toBe(账号.key("acc_2"));
  });

  it("目录名里不出现账号原文——它会出现在日志和窗口标题里", () => {
    const k = 账号.key("13800138000");
    expect(k).not.toContain("13800138000");
    expect(k).toMatch(/^[0-9a-f]{24}$/);
  });

  it("空账号给不出 key，宁可没有也不要一个所有人共用的目录", () => {
    expect(账号.key("")).toBeNull();
    expect(账号.key(null)).toBeNull();
    expect(账号.key(undefined)).toBeNull();
  });
});

describe("分得开", () => {
  it("两个账号落在两个目录，互相看不见", () => {
    const 甲 = 账号.认领(根, "acc_甲");
    fs.writeFileSync(path.join(甲.目录!, "crm.db"), "甲的数据");
    const 乙 = 账号.认领(根, "acc_乙");
    expect(乙.目录).not.toBe(甲.目录);
    expect(fs.existsSync(path.join(乙.目录!, "crm.db"))).toBe(false);
    // 甲那份原样留着
    expect(fs.readFileSync(path.join(甲.目录!, "crm.db"), "utf8")).toBe("甲的数据");
  });

  it("换成别人，路径变了——调用方据此重启本地服务", () => {
    账号.认领(根, "acc_甲");
    expect(账号.认领(根, "acc_乙").换了目录).toBe(true);
  });

  it("同一个人再登录一次，什么都不动", () => {
    账号.认领(根, "acc_甲");
    expect(账号.认领(根, "acc_甲").换了目录).toBe(false);
  });

  it("甲退出、乙登录、乙退出、甲再回来：甲的数据还在原处", () => {
    const 甲 = 账号.认领(根, "acc_甲");
    fs.writeFileSync(path.join(甲.目录!, "crm.db"), "甲的数据");
    账号.退出(根);
    const 乙 = 账号.认领(根, "acc_乙");
    fs.writeFileSync(path.join(乙.目录!, "crm.db"), "乙的数据");
    账号.退出(根);
    const 甲回来 = 账号.认领(根, "acc_甲");
    expect(甲回来.目录).toBe(甲.目录);
    expect(fs.readFileSync(path.join(甲回来.目录!, "crm.db"), "utf8")).toBe("甲的数据");
  });
});

describe("退出登录", () => {
  it("只清指针，数据一个字节都不动", () => {
    const 甲 = 账号.认领(根, "acc_甲");
    fs.writeFileSync(path.join(甲.目录!, "crm.db"), "甲的数据");
    账号.退出(根);
    expect(账号.读指针(根)).toBeNull();
    expect(fs.readFileSync(path.join(甲.目录!, "crm.db"), "utf8")).toBe("甲的数据");
  });

  it("退出之后再打开应用，落到未认领目录——登录页本身也要一个能跑的库", () => {
    账号.认领(根, "acc_甲");
    账号.退出(根);
    expect(账号.当前目录(根).key).toBe(账号.未认领);
  });
});

describe("归属标记（退出登录也不动它）", () => {
  it("认领之后目录上记着归谁", () => {
    const r = 账号.认领(根, "acc_甲");
    expect(账号.归谁(r.目录!)).toBe("acc_甲");
  });

  it("**退出登录不清归属**——这正是甲退出、乙登录时认出「换人了」的唯一依据", () => {
    /*
      归属原来是靠 .cloud.json 里的 accountId 认的，那是错的：那份文件是令牌，
      退出登录时会被删掉。甲退出之后 .cloud.json 不存在，乙在同一个目录上登录，
      服务端就看不出换了人——于是乙的名字和邮箱会被写进**甲的 User 表**。
      所以归属另记一份，退出不动它。
    */
    const 甲 = 账号.认领(根, "acc_甲");
    账号.退出(根);
    expect(账号.归谁(甲.目录!)).toBe("acc_甲");
  });

  it("未认领的目录没有归属——谁登录就归谁，不算换人", () => {
    expect(账号.归谁(账号.当前目录(根).目录)).toBeNull();
  });

  it("认领未认领的那份之后，归属就记上了", () => {
    账号.当前目录(根);
    const r = 账号.认领(根, "acc_甲");
    expect(账号.归谁(r.目录!)).toBe("acc_甲");
  });
});

describe("升级：老的那一份 data/", () => {
  it("认领给 .cloud.json 里那个人，只改名不复制", () => {
    造旧数据("acc_甲");
    const r = 账号.迁移旧数据(根, 取账号id);
    expect(r?.认领了).toBe(true);
    // 老路径没了（是改名不是复制），数据在新家
    expect(fs.existsSync(path.join(根, "data"))).toBe(false);
    expect(fs.readFileSync(path.join(r!.目录, "crm.db"), "utf8")).toBe("这是甲的客户数据");
    // 指针也指过去了：升级完打开应用，还是他自己那份
    expect(账号.读指针(根)).toBe(账号.key("acc_甲"));
  });

  it("读不出账号就放进未认领，**绝不猜一个账号塞给它**", () => {
    造旧数据(); // 没有 .cloud.json
    const r = 账号.迁移旧数据(根, 取账号id);
    expect(r?.认领了).toBe(false);
    expect(r?.key).toBe(账号.未认领);
    expect(fs.readFileSync(path.join(r!.目录, "crm.db"), "utf8")).toBe("这是甲的客户数据");
    // 指针仍然是空的：下一次谁登录谁认领
    expect(账号.读指针(根)).toBeNull();
  });

  it("未认领的那份，第一次登录就归他", () => {
    造旧数据();
    账号.迁移旧数据(根, 取账号id);
    const r = 账号.认领(根, "acc_甲");
    expect(r.认领了未认领的).toBe(true);
    expect(fs.readFileSync(path.join(r.目录!, "crm.db"), "utf8")).toBe("这是甲的客户数据");
  });

  it("认领未认领的那份也算换了目录——CRM_DATA_DIR 是启动时烤进子进程的字符串", () => {
    /*
      第一版这里返回的是「不用重启」，理由是「改的是目录名，服务连着的 inode 没变」。
      对了一半：已经打开的 fd 确实还能用，**但 CRM_DATA_DIR 是个字符串**，
      目录一改名它就指向一个不存在的路径，而服务端每次请求都要现读
      <CRM_DATA_DIR>/.cloud.json 拿 AI 配置。表现是数据还在、人却像突然退了登录。
      所以改名和换目录一样危险，路径变了就得重起服务。
    */
    造旧数据();
    账号.迁移旧数据(根, 取账号id);
    expect(账号.认领(根, "acc_甲").换了目录).toBe(true);
  });

  it("他以前就有自己那份时，未认领的不许盖上去", () => {
    /*
      场景：甲登录过（有 accounts/<甲>/），退出了，这时来了一份未认领的数据
      （比如手工放的、或者迁移时读不出账号）。甲再登录——他原来那份是真的，
      未认领那份来历不明，绝不能拿后者盖掉前者。
    */
    const 甲 = 账号.认领(根, "acc_甲");
    fs.writeFileSync(path.join(甲.目录!, "crm.db"), "甲原来的数据");
    账号.退出(根);
    const 未认领目录 = 账号.账号目录(根, 账号.未认领);
    fs.mkdirSync(未认领目录, { recursive: true });
    fs.writeFileSync(path.join(未认领目录, "crm.db"), "来历不明的数据");

    const r = 账号.认领(根, "acc_甲");
    expect(fs.readFileSync(path.join(r.目录!, "crm.db"), "utf8")).toBe("甲原来的数据");
    // 那份来历不明的留在原地，没被删也没被搬走
    expect(fs.readFileSync(path.join(未认领目录, "crm.db"), "utf8")).toBe("来历不明的数据");
  });

  it("每次启动都会调，跑第二遍什么都不做", () => {
    造旧数据("acc_甲");
    expect(账号.迁移旧数据(根, 取账号id)).not.toBeNull();
    expect(账号.迁移旧数据(根, 取账号id)).toBeNull();
  });

  it("目标已经存在时不覆盖，把老的留在原地让人来看", () => {
    // 迁到一半断电、或者有人手工动过：宁可两份都留着，也不能悄悄盖掉一份
    const 甲目录 = 账号.账号目录(根, 账号.key("acc_甲"));
    fs.mkdirSync(甲目录, { recursive: true });
    fs.writeFileSync(path.join(甲目录, "crm.db"), "新家里已经有的数据");
    造旧数据("acc_甲");

    expect(账号.迁移旧数据(根, 取账号id)).toBeNull();
    expect(fs.existsSync(path.join(根, "data", "crm.db"))).toBe(true);
    expect(fs.readFileSync(path.join(甲目录, "crm.db"), "utf8")).toBe("新家里已经有的数据");
  });

  it("没有老数据就什么都不做——全新安装走的是这条", () => {
    expect(账号.迁移旧数据(根, 取账号id)).toBeNull();
  });
});
