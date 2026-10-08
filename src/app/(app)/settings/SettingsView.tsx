"use client";

import { useBusinessTimeZone } from "@/lib/business-client";

import { useState } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { PageHead } from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import type { 机器 } from "./actions";
import MembersTab, { type Row } from "./MembersTab";
import PasswordTab from "./PasswordTab";
import AuditTab, { type AuditRow } from "./AuditTab";
import AiSettingsTab, { type LlmView } from "./AiSettingsTab";
import BusinessSettingsTab from "./BusinessSettingsTab";
import DesktopTab, { type 桌面端信息 } from "./DesktopTab";
import TeamTab from "./TeamTab";
import ImportsTab from "./ImportsTab";
import ProfileTab from "./ProfileTab";
import KeymapTab from "./KeymapTab";
import AppearanceTab from "./AppearanceTab";
import type { BusinessConfig } from "@/lib/business-config";
import type { AiUsage } from "@/lib/ai-usage";

/** 左目录里每一项底下那句话。放在组件外面，免得每次渲染重建 */
const 说明表: Record<string, string> = {
  profile: "你的名字、职位",
  keymap: "键盘上那几个键",
  appearance: "底色和主题",
  members: "谁能进、谁是管理员",
  password: "改密码、看哪几台机器登录着",
  desktop: "账号、备份、更新",
  team: "和同事同步客户、跟进、商机",
  ai: "走哪把 Key、还剩几次",
  business: "客户 / 学员 这些叫法",
  imports: "导进来的那几批，可撤销",
  audit: "每一次改动的记录",
};

export default function SettingsView({
  users,
  me,
  isAdmin,
  logs,
  llm,
  business,
  aiUsage,
  机器,
  桌面端 = null,
  用邮箱登录 = false,
  共享区 = false,
}: {
  users: Row[];
  me: SessionUser;
  isAdmin: boolean;
  logs: AuditRow[];
  llm: LlmView;
  business: BusinessConfig;
  aiUsage: AiUsage;
  /**
   * 用这个云端账号登录着的桌面端机器。**null 表示这一栏不适用**（自部署版、共享工作区），
   * 空数组表示一台都没有。见 actions.ts 的 我的控制面账号。
   */
  机器: 机器[] | null;
  /**
   * 桌面端本地模式：多一栏「桌面端」（账号、备份、更新），同时**不摆「登录与密码」**——
   * 那一栏改的是本机业务账号的密码，而桌面端只有云端账号这一套身份（2026-09-17 起），
   * 本机那把密码用户永远用不到，摆着只会再造出两把密码对不上的局面。null 表示不是桌面端。
   */
  桌面端?: 桌面端信息 | null;
  /** 托管版：成员的登录标识是邮箱，不是用户名。见 MembersTab 表单里那段注释 */
  用邮箱登录?: boolean;
  /** 网页试用版那个共享工作区：个人资料、登录与密码两栏不摆 */
  共享区?: boolean;
}) {
  const [搜, set搜] = useState("");
  // 当前页签由地址栏 ?tab= 决定：中栏那列设置项就是一组带 tab 的链接，刷新、回退都对得上
  const timeZone = useBusinessTimeZone();
  const pathname = usePathname();
  const tab = useSearchParams().get("tab") ?? "members";

  /** 设置的几项。说明一句话写清这一项管什么——只有名字的话，「业务配置」是个谜 */
  const 目录: { key: string; label: string; 说明: string; children: React.ReactNode }[] = [
    /**
     * 个人资料排第一：这一页最常被打开的原因是「改我自己的什么」，
     * 而不是「管别人」。改名以前只在「团队成员」那个只有管理员打得开的弹窗里，
     * 于是销售想改自己的名字得去求管理员。
     */
    { key: "profile", label: "个人资料", children: <ProfileTab me={{ name: me.name, title: me.title, email: me.email }} 云端账号={桌面端?.账号 ?? null} /> },
    { key: "members", label: "团队成员", children: <MembersTab users={users} me={me} isAdmin={isAdmin} 用邮箱登录={用邮箱登录} /> },
    { key: "keymap", label: "快捷键", children: <KeymapTab 桌面端={Boolean(桌面端)} /> },
    { key: "appearance", label: "外观", children: <AppearanceTab /> },
    { key: "password", label: "登录与密码", children: <PasswordTab 机器={机器} /> },
    ...(桌面端 ? [{ key: "desktop", label: "桌面端", children: <DesktopTab 信息={桌面端} /> }] : []),
    // 团队同步（2026-10-03）：几个人各用桌面端时互相同步。只在桌面端本地模式有——网页版本来就是一份库
    ...(桌面端 ? [{ key: "team", label: "团队", children: <TeamTab /> }] : []),
    // AI 接入是本机的（桌面端团队版的业务员在自己电脑上也能配）；业务配置全团队一份，只有管理员 / 老板改
    ...(isAdmin || 桌面端 ? [{ key: "ai", label: "AI 接入", children: <AiSettingsTab llm={llm} usage={aiUsage} /> }] : []),
    ...(isAdmin ? [{ key: "business", label: "业务配置", children: <BusinessSettingsTab value={business} 多人={users.filter((u) => u.active).length > 1} /> }] : []),
    { key: "imports", label: "导入记录", children: <ImportsTab /> },
    { key: "audit", label: "操作日志", children: <AuditTab logs={logs} /> },
  ]
    /**
     * 桌面端是**一个人用的**：数据在他自己机器上，登录的是他自己的云端账号，
     * 「团队成员」那一栏只会列出他一个人，还摆着「新增成员」——那是个会骗人的入口：
     * 在本机库里加出来的人没有云端账号，登不进任何地方（2026-09-18 用户指出）。
     * 要多人一起用，是「连接服务器」那条路，不是在这台机器上加账号。
     *
     * 「登录与密码」不摆的理由同源：桌面端只有云端账号这一套身份，本机那把密码用不到。
     */
    .filter((x) => !(桌面端 && (x.key === "password" || x.key === "members")))
    // 共享试用区：账号是几个团队共用的，名字和密码不给改（排查 A3）
    .filter((x) => !(共享区 && (x.key === "password" || x.key === "profile")))
    .map((x) => ({ ...x, 说明: 说明表[x.key] ?? "" })) as { key: string; label: string; 说明: string; children: React.ReactNode }[];

  /**
   * 分组：**「我自己的」和「整个团队的」分开**——这两件事的心理位置不一样。
   * 顺序就是这里的顺序，不跟着上面那个数组走（那个数组是按谁先写的排的）。
   * 没列进来的 key 会落到最后一组，加了新栏忘了分组也不会凭空消失。
   */
  const 分组表: [string, string[]][] = [
    ["个人", ["profile", "password", "keymap", "appearance"]],
    ["工作区", ["members", "business", "ai", "imports", "audit"]],
    ["应用", ["desktop", "team"]],
  ];

  /**
   * **真正摆出来的是哪一栏**。地址栏没带 ?tab= 时默认是 members，
   * 但桌面端不摆「团队成员」，网页版的普通成员也看不到它——这时正文落到第一栏（个人资料），
   * 而左边目录还在找 members，于是**哪一项都不亮**，看上去像选中了鼠标停着的那项
   * （2026-09-28 用户截图：「桌面端」发灰、正文是个人资料）。
   * 左边亮哪项、正文画哪栏、读屏的 aria 指向，三处都只认这一个值。
   */
  const 当前 = 目录.some((x) => x.key === tab) ? tab : 目录[0].key;

  const 词 = 搜.trim().toLowerCase();
  const 搜到的 = 词 ? 目录.filter((x) => `${x.label}${x.说明}${x.key}`.toLowerCase().includes(词)) : 目录;
  const 分好组: [string, typeof 目录][] = 词
    ? [["", 搜到的]]
    : 分组表
        .map(([名, keys]) => [名, keys.map((k) => 搜到的.find((x) => x.key === k)).filter(Boolean)] as [string, typeof 目录])
        .concat([["其它", 搜到的.filter((x) => !分组表.some(([, ks]) => ks.includes(x.key)))]])
        .filter(([, 项]) => 项.length > 0);

  return (
    <>
      <PageHead title="设置" subtitle={`成员、AI 与业务配置 · ${timeZone ? "业务日期按北京时间（UTC+8）" : "业务日期按本机时区"}`} />

      {/*
        左目录，不是顶上一排页签。有两项只有管理员看得到，页签横着排时
        管理员和普通成员看到的宽度都不一样；竖着排还能给每项留一句说明。
        角色仍然是 tablist / tab / tabpanel——读屏按这个认，e2e 也按这个找。
        窄屏下目录仍然是单列，只是压到正文上面（见 globals.css 的 .set）。

        **分组和搜索是 2026-09-17 加的**（对着 Claude / Codex 桌面端那两个设置窗口）：
        项数到了八个，一列平铺就开始要一项项扫。分组把「我自己的」和「整个团队的」分开——
        这两件事的心理位置完全不同。搜索框在项数少时是多余的，但它救的是
        「我知道那个开关叫什么、但不知道它在哪一栏」，而那正是设置页最常见的一次来访。
      */}
      <div className="set">
        <div className="set-nav" role="tablist" aria-orientation="vertical" aria-label="设置分类">
          <input
            className="set-search"
            type="search"
            value={搜}
            onChange={(e) => set搜(e.target.value)}
            placeholder="搜设置…"
            aria-label="搜索设置"
          />
          {搜到的.length === 0 && <div className="set-nav-empty">没有匹配的设置项</div>}
          {分好组.map(([组名, 项]) => (
            <div key={组名} className="set-nav-g">
              {/* 搜索时不摆组标题：那时人要的是一份短名单，不是结构 */}
              {!搜.trim() && <div className="set-nav-h">{组名}</div>}
              {项.map((x) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              id={`set-tab-${x.key}`}
              aria-selected={当前 === x.key}
              aria-controls={`set-panel-${x.key}`}
              className={`set-nav-i${当前 === x.key ? " on" : ""}`}
              /*
                用原生 history 而不是 router.replace：这一页是 force-dynamic 的服务端组件，
                router.replace 改个 ?tab= 会让 Next 把整页重新向服务端要一遍——200 条操作日志、
                成员、AI 配置，桌面端还要去云端问一次余额。切个页签卡半秒，就是这么来的
                （2026-09-17 用户在真机上感觉到「偶尔卡卡的」）。Next 会把原生 pushState/replaceState
                同步进 useSearchParams，所以下面读 tab 的那行照旧生效，刷新、回退也照旧对得上。
              */
              onClick={() => window.history.replaceState(null, "", `${pathname}?tab=${x.key}`)}
            >
              <b>{x.label}</b>
              <span>{x.说明}</span>
            </button>
              ))}
            </div>
          ))}
        </div>
        <div className="set-body" role="tabpanel" id={`set-panel-${当前}`} aria-labelledby={`set-tab-${当前}`}>
          {目录.find((x) => x.key === 当前)?.children}
        </div>
      </div>
    </>
  );
}
