"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue } from "motion/react";
import {
  AudioOutlined, CalendarFilled, CalendarOutlined, CheckCircleFilled, CloseCircleFilled, CloseOutlined, CloudSyncOutlined, CopyOutlined,
  DisconnectOutlined, EditOutlined, ExclamationCircleFilled, LaptopOutlined, LinkOutlined, LockOutlined, MailOutlined, MobileOutlined, PhoneOutlined, PlusOutlined, RightOutlined,
  SearchOutlined, WhatsAppOutlined, CameraOutlined, PictureOutlined,
} from "@ant-design/icons";
import * as 同步 from "@/lib/mobile/sync";
import * as 连 from "@/lib/mobile/link";
import * as 密 from "@/lib/sync/crypto-web";
import { 我的名字 } from "@/lib/mobile/view";
import { 本地库, 申请长期保存 } from "@/lib/mobile/store";
import { 分表, 客户们 as 算客户们, 今天要跟, 搜, 国旗, 简称, 相对时间, 同步条, 首次同步失败, 金额, 要清掉, type 客户视图 } from "@/lib/mobile/view";
import { Avatar, BaseLayer, InstallHint, Page, Sheet, StatusTag, SyncChip, TabBar, TopLayer, 已装到主屏幕, 认浏览器, 弹簧, 猜系统, 震一下, type 标签, type 系统 } from "./ui";
import { 现状动效 } from "@/lib/motion";
import { stageLabel, 外贸订单, type BusinessConfig } from "@/lib/business-config";
import { 订单前缀 } from "@/lib/follow-link";
import { 国家候选 } from "@/lib/customer-extra";
import { 推入 } from "./push";
import { BrowserTip, ScanBar, ScanButton, useCardScan, usePickPhoto, NoCameraTip } from "./CardScan";
import { 只补空格, 空名片表单, type 名片表单 } from "@/lib/card-scan/form";
import { 设识别令牌 } from "@/lib/card-scan/cloud";
import { 号键 } from "@/lib/phone";
import "./m.css";

/**
 * 手机版（2026-10-15，方案：~/Opensource_CRM/02-开发与发版/手机端-方案-20261015.md）。
 *
 *   登录（账号密码 → 长期令牌）→ 申请（手机生成不可导出的钥匙对，屏幕上显示配对数字）→ 本人电脑点允许
 *   → 首次同步（按范围拉，业务员只有本人 + 公海）→ 今天 / 客户 / 详情 / 记一笔
 *
 * 数据只在这台手机（IndexedDB，每行再加密一层）和本人、老板的电脑上；我们的服务器只转交密文。
 * 登录失效（电脑上移除了这台手机、或者改过密码）：手机上的客户数据和团队钥匙立刻清掉，没同步上的跟进单独留着给人复制。
 */

type 阶段 = "boot" | "login" | "authorize" | "syncing" | "app";
type 面板 = null | { kind: "record"; id: string } | { kind: "me" } | { kind: "unsynced" } | { kind: "sync" } | { kind: "newCustomer"; 图?: File } | { kind: "newOpp"; id: string };
type 设备 = { device: string; 公钥: string; 私钥: 密.设备私钥 };
type 账号 = { name: string; contact: string };
type 遗留 = { content: string; customer: string; at: number };
/** 同步状态会被同步库原地改，放在 ref 里只在回调中动；渲染读这一份快照（改完一次拍一次） */
type 快照 = { 待推跟进: string[]; 待推新建: string[]; 被拒: { content: string; customerId: string; 客户名: string; at: number; 原因: string }[]; 上次成功: number | null; lastError: string | null };
/**
 * 没同步上时列给人看的几样：跟进，和手机上新建的客户、商机（2026-10-19）。档案、币种、操作日志跟着它们走，不单列；
 * 领公海时改负责人、带过来的活（改动，不是新建）也不单列——没抢到时跟进那一条写着「已被 X 先领走」
 */
const 列给人看 = (e: 同步.改动) => (e.t === "FollowUp" || ((e.t === "Customer" || e.t === "Opportunity") && e.o === "I")) && !!e.r;
const 这条说的 = (e: 同步.改动) => {
  const r = e.r ?? {};
  if (e.t === "Customer") return { content: `新建客户「${String(r.name ?? "")}」${r.phone ? `，电话 ${String(r.phone)}` : ""}`, customerId: e.k, 客户名: String(r.name ?? ""), at: Number(r.createdAt) || 0 };
  if (e.t === "Opportunity") return { content: `新建商机「${String(r.name ?? "")}」，金额 ${Number(r.amount) || 0}，${String(r.stage ?? "")}`, customerId: String(r.customerId ?? ""), 客户名: "", at: Number(r.createdAt) || 0 };
  return { content: String(r.content ?? ""), customerId: String(r.customerId ?? ""), 客户名: "", at: Number(r.occurredAt) || 0 };
};
/** 被拒的那条，连带它的档案 / 币种（同一个主键）和操作日志 */
const 跟着它 = (它: 同步.改动, e: 同步.改动) =>
  e === 它
  || (e.t === "AuditLog" && `${String(e.r?.entity ?? "")}:${String(e.r?.entityId ?? "")}` === `${它.t}:${它.k}`)
  || (它.t === "Customer" && e.t === "CustomerExtra" && e.k === 它.k)
  || (它.t === "Opportunity" && e.t === "OpportunityMoney" && e.k === 它.k)
  || (它.t === "FollowUp" && e.t === "FollowUpOrder" && e.k === 它.k);
const 拍 = (s: 同步.同步状态): 快照 => ({
  待推跟进: s.待推.filter((e) => e.t === "FollowUp").map((e) => e.k),
  待推新建: s.待推.filter((e) => e.t === "Customer" || e.t === "Opportunity").map((e) => e.k),
  被拒: s.被拒.filter((x) => 列给人看(x.改动)).map((x) => ({ ...这条说的(x.改动), 原因: x.原因 })),
  上次成功: 同步.上次成功(s),
  lastError: s.lastError ?? null,
});

const 少动查询 = "(prefers-reduced-motion: reduce)";
const 订少动 = (cb: () => void) => { const m = window.matchMedia(少动查询); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
const 读少动 = () => window.matchMedia(少动查询).matches;
const 订尺寸 = (cb: () => void) => { window.addEventListener("resize", cb); return () => window.removeEventListener("resize", cb); };
const 不订 = () => () => {};
const 类型表 = [
  { value: "PHONE", 短: "电话", color: "var(--cat-green)", label: "电话沟通" },
  { value: "WHATSAPP", 短: "WhatsApp", color: "var(--cat-teal)", label: "WhatsApp" },
  // 微信沟通（2026-10-19 客户反馈第 3 条）：和电脑上同一个色（--cat-lime，外贸功能分支加进 globals.css）；还没合并时先用绿色
  { value: "WECHAT", 短: "微信", color: "var(--cat-lime, var(--cat-green))", label: "微信沟通" },
  { value: "SMS", 短: "消息", color: "var(--cat-cyan)", label: "短信沟通" },
  { value: "EMAIL", 短: "邮件", color: "var(--cat-pink)", label: "邮件沟通" },
  { value: "MEETING", 短: "会议", color: "var(--cat-blue)", label: "线上会议" },
  { value: "VISIT", 短: "拜访", color: "var(--cat-violet)", label: "上门拜访" },
  { value: "OTHER", 短: "其他", color: "var(--text-muted)", label: "其他记录" },
] as const;
const 类型 = (v: string) => 类型表.find((x) => x.value === v) ?? { value: v, 短: v, color: "var(--text-muted)", label: v === "TASK" ? "跟进任务" : v === "REMIND" ? "跟进提醒" : "其他记录" };
const 阶段表 = ["初步沟通", "需求确认", "方案报价", "谈判审核", "赢单成交"];

function 设备标签() {
  const ua = navigator.userAgent;
  const 机 = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? (/; ([^;)]+) Build\//.exec(ua)?.[1]?.trim() || "安卓手机") : "手机";
  return `${机} · ${认浏览器(ua)}`.slice(0, 60);
}

/** 请求超时。AbortSignal.timeout 要 Chrome 103：夸克（内核 Chrome 100）上没有，直接抛错就成了「连不上网络」（10-15 真机） */
function 超时(毫秒: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(毫秒);
  const c = new AbortController();
  setTimeout(() => c.abort(), 毫秒);
  return c.signal;
}

/** 和云端说话：同源接口 + 手机自己的令牌。断网回 状态 0 */
function 做传输(token: string, 记断网: (断: boolean) => void): 同步.传输 {
  return async (方法, 路径, body) => {
    try {
      const r = await fetch(路径, {
        method: 方法, cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: 超时(30_000),
      });
      记断网(false);
      return { 状态: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    } catch {
      记断网(true);
      return { 状态: 0, json: { error: "连不上网络" } };
    }
  };
}

export default function MobileApp() {
  const 真系统 = useSyncExternalStore(不订, 猜系统, () => "ios" as 系统);
  const os = 真系统;
  const 宽 = useSyncExternalStore(订尺寸, () => window.innerWidth, () => 390);
  const [阶段, set阶段] = useState<阶段>("boot");
  // 本地库是会原地变的对象：放在 state 里拿稳引用，变了靠「版本」重画
  const [库, set库] = useState<本地库 | null>(null);
  const [token, setToken] = useState<string | null>(null);
  // 扫名片先交给服务器认（团队版），要这枚令牌
  useEffect(() => { 设识别令牌(token); }, [token]);
  const [团队, set团队] = useState<同步.手机团队 | null>(null);
  const [团队名, set团队名] = useState("");
  const [登录账号, set账号] = useState<账号 | null>(null);
  const [现在, set现在] = useState(() => Date.now());
  const 态 = useRef<同步.同步状态>(同步.新状态());
  const [快照, set快照] = useState<快照>(() => 拍(同步.新状态()));
  // 顺手把「现在」拨到此刻：刚同步完、刚记完的不会因为「现在」还停在 30 秒前而显示成「今天 hh:mm」
  const 拍一下 = useCallback(() => { set快照(拍(态.current)); set现在(Date.now()); }, []);
  const 取状态 = useCallback(() => 态.current, []);
  const [版本, set版本] = useState(0);
  const [在同步, set在同步] = useState(false);
  const [断网, set断网] = useState(false);
  const [提示, set提示] = useState<{ id: number; 字: string; 图?: ReactNode } | null>(null);
  const [失效提示, set失效提示] = useState<string | null>(null);
  const [遗留们, set遗留们] = useState<遗留[]>([]);
  const [tab, setTab] = useState<标签>("today");
  const [详情, set详情] = useState<string | null>(null);
  const [面板, set面板] = useState<面板>(null);
  const 同步中 = useRef(false);
  // 推入推出（2026-10-15 重做，见 push.ts）：进度 p 一个数，0 = 详情完全进来，1 = 完全退回
  const 进度 = useMotionValue(1);
  // 系统的「减弱动态效果」：自己订（motion 的 useReducedMotion 中途改了设置不会跟着变）
  const 少动 = useSyncExternalStore(订少动, 读少动, () => false);
  const [退着, set退着] = useState(false);
  const 层 = useRef({ 详情: null as string | null, 面板: null as 面板 });
  const [推] = useState(() => new 推入({
    值: 进度,
    动画: (到, 秒) => animate(进度, 到, { duration: 秒, ease: 现状动效.曲线.ease }),
    // 整程用形变档（iOS 推入差不多也是这么长）；减弱动态效果时只淡入淡出，用常规档
    时长: { 整程: 现状动效.时长.morph, 淡: 现状动效.时长.base, 最短: 现状动效.时长.fast },
    退完: () => set详情(null),
    要返回: () => history.back(),
    目标变了: (目标) => set退着(目标 === "退回"),
  }));
  useEffect(() => { 层.current = { 详情, 面板 }; 推.设(宽, 少动); });
  // 本人的新电脑 / 新手机来要授权（2026-10-15，0.46.17）：这台手机也能点允许
  const [待批, set待批] = useState<连.待授权 | null>(null);
  const 稍后批 = useRef(new Set<string>());
  const [设备版本, set设备版本] = useState(0);

  const 说 = useCallback((字: string, 图?: ReactNode) => set提示({ id: Date.now(), 字, 图 }), []);
  useEffect(() => { if (!提示) return; const t = setTimeout(() => set提示(null), 2400); return () => clearTimeout(t); }, [提示]);
  useEffect(() => { const t = setInterval(() => set现在(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { document.documentElement.classList.add("m-page"); return () => document.documentElement.classList.remove("m-page"); }, []);

  /* ---------- 打开：读本地库，决定从哪一步开始 ---------- */
  useEffect(() => {
    let 停 = false;
    (async () => {
      const k = await 本地库.打开();
      if (停) return;
      set库(k);
      const [t, 团, 态0, 名, 号, 遗] = await Promise.all([k.读("token"), k.读("team"), k.读("state"), k.读("teamName"), k.读("account"), k.读("leftover")]);
      if (停) return;
      if (态0) { 态.current = 态0 as 同步.同步状态; set快照(拍(态.current)); }
      set遗留们((遗 as 遗留[] | undefined) ?? []);
      set账号((号 as 账号 | undefined) ?? null);
      set团队名(String(名 ?? ""));
      if (!t) { set阶段("login"); return; }
      setToken(String(t));
      if (!团) { set阶段("authorize"); return; }
      set团队(团 as 同步.手机团队);
      set版本((v) => v + 1);
      set阶段("app");
    })().catch(() => set阶段("login"));
    return () => { 停 = true; };
  }, []);

  const 云 = useMemo(() => (token ? 做传输(token, set断网) : null), [token]);

  /** 登录失效：业务数据、团队钥匙、令牌全清；没同步上的跟进单独留着 */
  const 失效 = useCallback(async (话: string) => {
    const k = 库;
    if (!k) return;
    const 没推的 = [...态.current.待推, ...态.current.被拒.map((x) => x.改动)].filter(列给人看);
    const 名们 = new Map((await k.键们()).filter((x) => x.startsWith("Customer:")).map((x) => [x.slice(9), ""]));
    for (const id of 名们.keys()) 名们.set(id, String((await k.取("Customer", id))?.r.name ?? ""));
    const 留 = [...遗留们, ...没推的.map((e) => { const x = 这条说的(e); return { content: x.content, customer: x.客户名 || 名们.get(x.customerId) || "", at: x.at || Date.now() }; })];
    await k.清空();
    await k.写("leftover", 留);
    态.current = 同步.新状态(); 拍一下();
    set遗留们(留); set团队(null); setToken(null); set详情(null); 推.复位(); set面板(null); set团队名("");
    set失效提示(话);
    set阶段("login");
  }, [遗留们, 库, 拍一下, 推]);

  /* ---------- 同步：打开时、回到前台时、恢复联网时、下拉时、记完一笔后；开着时每 30 秒 ---------- */
  const 跑同步 = useCallback(async (手动 = false) => {
    const k = 库;
    if (!k || !团队 || !云 || 同步中.current) return;
    同步中.current = true;
    set在同步(true);
    try {
      const 前 = 态.current.待推.length;
      const r = await 同步.同步一轮(团队, 云, k, 态.current);
      if (r.c !== 团队) { set团队(r.c); await k.写("team", r.c); }
      await k.存盘();
      await k.写("state", 态.current);
      if (前 > 0 && r.推 > 0) 说("已同步到电脑", <LaptopOutlined />);
      if (r.拒 > 0) 说(`有 ${r.拒} 条没同步上，客户已经不归你了`, <ExclamationCircleFilled />);
    } catch (e) {
      const 话 = e instanceof Error ? e.message : String(e);
      const 清 = 要清掉(话);
      if (清) { await 失效(清); return; }
      await k.存盘().catch(() => undefined);
      await k.写("state", 态.current).catch(() => undefined);
      if (手动) 说(/连不上/.test(话) ? "没有网络，记的内容先存在手机上" : 话, <DisconnectOutlined />);
    } finally {
      同步中.current = false;
      set在同步(false);
      拍一下();
      set版本((v) => v + 1);
    }
  }, [团队, 云, 说, 失效, 库, 拍一下]);

  useEffect(() => {
    if (阶段 !== "app") return;
    const 首 = setTimeout(() => void 跑同步(), 0);
    const t = setInterval(() => { if (!document.hidden) void 跑同步(); }, 30_000);
    const 前台 = () => { if (!document.hidden) void 跑同步(); };
    const 联网 = () => void 跑同步();
    document.addEventListener("visibilitychange", 前台);
    window.addEventListener("online", 联网);
    return () => { clearTimeout(首); clearInterval(t); document.removeEventListener("visibilitychange", 前台); window.removeEventListener("online", 联网); };
  }, [阶段, 跑同步]);

  /* ---------- 本人的新设备来要授权：在前台时每 15 秒问一次，回到前台马上问（和电脑上的 MobileAuthPrompt 一样） ---------- */
  useEffect(() => {
    if (阶段 !== "app" || !云) return;
    let 停 = false;
    const 问 = async () => {
      if (document.hidden || 停) return;
      const 列 = await 连.待授权的(云).catch(() => null);
      if (停 || !列) return;
      const x = 列.find((p) => !稍后批.current.has(p.id));
      set待批((旧) => 旧 ?? x ?? null);
    };
    void 问();
    const t = setInterval(() => void 问(), 15_000);
    const 回前台 = () => { if (!document.hidden) void 问(); };
    document.addEventListener("visibilitychange", 回前台);
    return () => { 停 = true; clearInterval(t); document.removeEventListener("visibilitychange", 回前台); };
  }, [阶段, 云]);

  async function 批(允许: boolean) {
    const x = 待批, k = 库;
    if (!x || !云 || !团队 || !k) return;
    try {
      if (允许) {
        // 先取一次钥匙：团队刚换过钥匙、这台手机还没同步到的话，封出去的得是现在这把
        const 新 = await 同步.更新钥匙(团队, 云);
        if (新 !== 团队) { set团队(新); await k.写("team", 新); }
        await 连.允许设备(云, 新, 团队名, x.id);
        说(x.电脑 ? "已授权，那台电脑马上开始同步" : "已授权，那台手机马上开始同步", <CheckCircleFilled />);
        set设备版本((v) => v + 1);
      } else {
        await 连.拒绝设备(云, x.id);
      }
      震一下();
      set待批(null);
    } catch (e) {
      说(e instanceof Error ? e.message : String(e), <ExclamationCircleFilled />);
    }
  }

  /* ---------- 返回：一律走浏览器历史（安卓返回键 / 手势和页面上的返回按钮同一条路） ---------- */
  useEffect(() => {
    const on = () => { if (层.current.面板) set面板(null); else if (层.current.详情) 推.去("退回"); };
    // 切后台 / 页面冻住时动画帧会停：切换的那一刻就把动画落到位
    const 收 = () => 推.收尾();
    window.addEventListener("popstate", on);
    document.addEventListener("visibilitychange", 收);
    window.addEventListener("pageshow", 收);
    window.addEventListener("pagehide", 收);
    return () => {
      window.removeEventListener("popstate", on);
      document.removeEventListener("visibilitychange", 收);
      window.removeEventListener("pageshow", 收);
      window.removeEventListener("pagehide", 收);
    };
  }, [推]);
  const 打开详情 = (id: string) => {
    // 已经在进来（连点同一行、或者进来的半路又点了一行）：换内容就行，不再记一笔历史
    if (推.目标 === "进来") { set详情(id); return; }
    history.pushState({ m: "detail" }, "");
    // 完全退回了从屏幕外进来；退回的半路又点进去，就从当前位置折返
    if (!详情) 进度.jump(1);
    set详情(id);
    推.去("进来");
  };
  const 打开面板 = (p: NonNullable<面板>) => { history.pushState({ m: "sheet" }, ""); set面板(p); };
  // 只在历史顶上确实是详情 / 面板时才退：退回的半路再点返回，不能把浏览器退到上一个网页去
  const 返回 = () => { if (面板 || 推.目标 === "进来") history.back(); };

  /* ---------- 数据 ---------- */
  const 我 = 团队?.userId ?? "";
  const 客户们 = useMemo(() => {
    void 版本;
    const k = 库;
    if (!k || !团队) return [] as 客户视图[];
    return 算客户们(分表(k.行.values()), 团队.userId, new Set(快照.待推跟进));
  }, [版本, 团队, 库, 快照]);
  // 名字以团队里自己那行 User 为准（电脑上改名后跟着变），拿不到再用登录时的账号名
  const 账号 = useMemo(() => {
    void 版本;
    if (!登录账号) return null;
    return { ...登录账号, name: 库 ? 我的名字(库.行, 我, 登录账号.name) : 登录账号.name };
  }, [版本, 库, 我, 登录账号]);
  const 待同步数 = 快照.待推跟进.length + 快照.待推新建.length;
  const 业务 = useMemo((): BusinessConfig => { void 版本; return 同步.读业务(库?.行.get(同步.业务行键)); }, [版本, 库]);
  const 没同步上 = useMemo(() => {
    const 名 = new Map(客户们.map((c) => [c.id, c.name]));
    return [
      ...快照.被拒.map((x, i) => ({ key: `r${i}`, 来自: "被拒" as const, i, content: x.content, customer: 名.get(x.customerId) || x.客户名, at: x.at, 原因: x.原因 })),
      ...遗留们.map((x, i) => ({ key: `l${i}`, 来自: "遗留" as const, i, ...x, 原因: "登录失效前没同步上" })),
    ];
  }, [客户们, 遗留们, 快照]);
  const 当前客户 = 客户们.find((c) => c.id === 详情) ?? null;
  const 建商机的 = 面板?.kind === "newOpp" ? 客户们.find((c) => c.id === 面板.id) ?? null : null;

  async function 记(id: string, 输入: Omit<同步.记跟进输入, "customerId">) {
    const k = 库;
    if (!k || !团队) return;
    try {
      const r = await 同步.记跟进(团队, k, 态.current, { customerId: id, ...输入 });
      await k.存盘();
      await k.写("state", 态.current);
      拍一下();
      set版本((v) => v + 1);
      震一下();
      说(r.领取了 ? (断网 ? "已记下 · 联网后替你领取" : "已领取并记下") : 断网 ? "已记下 · 有网后自动同步" : "已记下", 断网 ? <CloudSyncOutlined /> : <CheckCircleFilled />);
      void 跑同步();
    } catch (e) {
      说(e instanceof Error ? e.message : String(e), <ExclamationCircleFilled />);
    }
  }

  /** 新建客户 / 商机：存进手机、马上同步。出错（缺电话、撞号）不关表单，返回那句话给表单显示；成了返回 null */
  /** 扫名片：来源记住上一次（这次打开 App 期间；比如「2026 迪拜展」，后面每张自动带上） */
  const [上次来源, set上次来源] = useState("");
  /** 新建客户撞了号：这台手机上那位（给「改成给老客户记一笔跟进」） */
  const 找老客户 = (phone: string, email: string) => {
    const 号 = phone.trim() ? 号键(phone) : "", 邮 = email.trim().toLowerCase();
    return 客户们.find((c) => (号 && c.phone && 号键(c.phone) === 号) || (邮 && c.email?.trim().toLowerCase() === 邮));
  };

  /** 留着 = 扫名片那一张：存完不关表单、不跳详情，表单里给「再扫一张」 */
  async function 新建(哪个: { 客户: 同步.新建客户输入 } | { 商机: 同步.新建商机输入 }, 留着 = false): Promise<string | null> {
    const k = 库;
    if (!k || !团队) return "还没连上团队";
    try {
      const r = "客户" in 哪个 ? await 同步.新建客户(团队, k, 态.current, 哪个.客户, Date.now(), 断网 || !云 ? undefined : 云) : await 同步.新建商机(团队, k, 态.current, 哪个.商机);
      await k.存盘();
      await k.写("state", 态.current);
      拍一下();
      set版本((v) => v + 1);
      震一下();
      const 成了 = "客户" in 哪个 ? "客户已建好" : "商机已建好";
      说(断网 ? `${成了} · 有网后自动同步` : 成了, 断网 ? <CloudSyncOutlined /> : <CheckCircleFilled />);
      void 跑同步();
      if ("客户" in 哪个) set上次来源(哪个.客户.source?.trim() ?? "");
      if (留着) return null;
      返回();
      if ("客户" in 哪个) setTimeout(() => 打开详情(r.id), 300);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async function 处理掉(x: { 来自: "被拒" | "遗留"; i: number }) {
    const k = 库;
    if (!k) return;
    if (x.来自 === "被拒") {
      const 剩 = 态.current.被拒.filter((r) => 列给人看(r.改动));
      const 去 = 剩[x.i];
      // 跟着它一起被拒的操作日志（lib/mobile/sync.ts 推）、新建客户的档案、新建商机的币种也一起去掉
      if (去) 态.current.被拒 = 态.current.被拒.filter((r) => !跟着它(去.改动, r.改动));
      await k.写("state", 态.current);
      拍一下();
    } else {
      const 留 = 遗留们.filter((_, i) => i !== x.i);
      set遗留们(留);
      await k.写("leftover", 留);
    }
    set版本((v) => v + 1);
  }

  async function 退出() {
    const k = 库;
    if (token) await fetch("/api/account/token", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    await k?.清空();
    态.current = 同步.新状态(); 拍一下();
    set团队(null); setToken(null); set账号(null); set遗留们([]); set面板(null); set详情(null); 推.复位(); set失效提示(null);
    set阶段("login");
  }

  const 根属性 = { "data-os": os } as Record<string, string>;
  const 今天 = 今天要跟(客户们, 我, 现在);
  const 今天数 = 今天.过期.length + 今天.今天.length;

  return (
    <div className="m-root" {...根属性}>
      <AnimatePresence mode="wait" initial={false}>
        {阶段 === "boot" && <motion.div key="boot" className="m-flow m-flow-center" exit={{ opacity: 0 }}><span className="m-spinner is-on" /></motion.div>}
        {阶段 === "login" && (
          <LoginFlow key="login" 失效提示={失效提示} 遗留={遗留们.length}
            onDone={async (t, 号) => {
              const k = 库!;
              await k.写("token", t); await k.写("account", 号);
              setToken(t); set账号(号); set失效提示(null);
              void 申请长期保存();
              set阶段("authorize");
            }} />
        )}
        {阶段 === "authorize" && token && (
          <AuthorizeFlow key="auth" token={token} 库={库!}
            onApproved={async (团, 名) => {
              const k = 库!;
              await k.写("team", 团); await k.写("teamName", 名);
              set团队(团); set团队名(名);
              set阶段("syncing");
            }}
            onRestart={async () => {
              // 旧令牌作废：它发的那条申请就不会再出现在电脑上（服务端只列令牌还活着的申请）
              await fetch("/api/account/token", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
              await 库?.写("token", undefined); setToken(null); set阶段("login");
            }} />
        )}
        {阶段 === "syncing" && 团队 && 云 && (
          <FirstSync key="sync" 团队={团队} 云={云} 库={库!} 取状态={取状态}
            onDone={async (c) => {
              const k = 库!;
              set团队(c); await k.写("team", c); await k.存盘(); await k.写("state", 态.current); 拍一下();
              set版本((v) => v + 1);
              set阶段("app");
            }}
            onFail={(话) => { const 清 = 要清掉(话); if (清) void 失效(清); }} />
        )}
        {阶段 === "app" && 团队 && (
          <motion.div key="app" className="m-app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 现状动效.时长.morph }}>
            <BaseLayer p={进度} 宽={宽} os={os} 少动={少动} 有详情={!!详情}>
              <div className="m-tabs-body">
                {tab === "today"
                  ? <TodayScreen os={os} 今天={今天} 现在={现在} 断网={断网} 待同步={待同步数} 上次成功={快照.上次成功} 错误={快照.lastError} 在同步={在同步}
                      没同步上={没同步上.length} onSyncInfo={() => 打开面板({ kind: "sync" })} 名={账号?.name ?? ""} onOpen={打开详情} onMe={() => 打开面板({ kind: "me" })} onUnsynced={() => 打开面板({ kind: "unsynced" })} onSync={() => 跑同步(true)} />
                  : <CustomersScreen os={os} 客户们={客户们} 我={我} 现在={现在} 断网={断网} 名={账号?.name ?? ""} onOpen={打开详情} onMe={() => 打开面板({ kind: "me" })} onSync={() => 跑同步(true)} onNew={() => 打开面板({ kind: "newCustomer" })} onScan={(f) => 打开面板({ kind: "newCustomer", 图: f })} />}
              </div>
              <TabBar os={os} tab={tab} onTab={(t) => { if (t !== tab) { setTab(t); 震一下(); } }} 今天数={今天数} />
            </BaseLayer>
            {当前客户 && (
              <TopLayer p={进度} 宽={宽} os={os} 少动={少动} 推={推} 退着={退着}>
                <DetailScreen os={os} c={当前客户} 现在={现在} 断网={断网} 来自={tab === "today" ? "今天" : "客户"} 业务={业务} 待同步={快照.待推新建} onBack={返回} onRecord={() => 打开面板({ kind: "record", id: 当前客户.id })} onNewOpp={() => 打开面板({ kind: "newOpp", id: 当前客户.id })} />
              </TopLayer>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {面板 && (
          <Sheet key={面板.kind} onClose={返回} 高={面板.kind === "me" || 面板.kind === "unsynced" || 面板.kind === "newCustomer" ? "tall" : "auto"}>
            {面板.kind === "record" && (() => {
              const c = 客户们.find((x) => x.id === 面板.id);
              if (!c) return null;
              return <RecordSheet c={c} os={os} 我={我} 断网={断网} 业务={业务} onCancel={返回} onSave={(输入) => { void 记(c.id, 输入); 返回(); }} />;
            })()}
            {面板.kind === "newCustomer" && (
              <NewCustomerSheet os={os} 业务={业务} 图={面板.图} 来源={上次来源} 找老={找老客户} onCancel={返回}
                onSave={(输入, 留着) => 新建({ 客户: 输入 }, 留着)}
                onRecordFor={(id) => { 返回(); setTimeout(() => 打开面板({ kind: "record", id }), 300); }} />
            )}
            {面板.kind === "newOpp" && 建商机的 && (
              <NewOppSheet c={建商机的} os={os} 业务={业务} onCancel={返回} onSave={(输入) => 新建({ 商机: { customerId: 建商机的.id, ...输入 } })} />
            )}
            {面板.kind === "me" && (
              <MeSheet 账号={账号} 团队名={团队名} 断网={断网} 待同步={待同步数} 在同步={在同步} 上次成功={快照.上次成功}
                错误={快照.lastError} 现在={现在} 没同步上={没同步上.length} 云={云} 团队={团队} 设备版本={设备版本}
                onSync={() => void 跑同步(true)} onUnsynced={() => { 返回(); setTimeout(() => 打开面板({ kind: "unsynced" }), 300); }}
                onLogout={() => { 返回(); setTimeout(() => void 退出(), 250); }} />
            )}
            {面板.kind === "sync" && (
              <SyncSheet 断网={断网} 待同步={待同步数} 在同步={在同步} 上次成功={快照.上次成功} 错误={快照.lastError} 现在={现在} onSync={() => void 跑同步(true)} />
            )}
            {面板.kind === "unsynced" && <UnsyncedSheet 列={没同步上} 说={说} on处理={(x) => void 处理掉(x)} />}
          </Sheet>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {待批 && !面板 && 阶段 === "app" && (
          <Sheet key={`approve-${待批.id}`} 高="auto" onClose={() => { 稍后批.current.add(待批.id); set待批(null); }}>
            <ApproveSheet x={待批} onAllow={() => 批(true)} onDeny={() => 批(false)} onLater={() => { 稍后批.current.add(待批.id); set待批(null); }} />
          </Sheet>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {提示 && (
          <motion.div key={提示.id} className="m-toast" initial={{ opacity: 0, y: -16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10 }} transition={弹簧}>
            {提示.图}<span>{提示.字}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ====================================================================== 今天 */

function TodayScreen({ os, 今天, 现在, 断网, 待同步, 上次成功, 错误, 在同步, 没同步上, 名, onOpen, onMe, onUnsynced, onSync, onSyncInfo }: {
  os: 系统; 今天: ReturnType<typeof 今天要跟>; 现在: number; 断网: boolean; 待同步: number; 上次成功: number | null; 错误: string | null; 在同步: boolean;
  没同步上: number; 名: string; onOpen: (id: string) => void; onMe: () => void; onUnsynced: () => void; onSync: () => Promise<void>; onSyncInfo: () => void;
}) {
  const d = new Date(现在);
  const 已装 = useSyncExternalStore(不订, 已装到主屏幕, () => true);
  const [关了装提示, set关了装提示] = useState(false);
  return (
    <Page os={os} 标题="今天" 右={<button className="m-me" onClick={onMe} aria-label="我的">{简称(名 || "我")}</button>}
      副标题={<><span>{d.getMonth() + 1}月{d.getDate()}日 周{"日一二三四五六"[d.getDay()]}</span><SyncChip 断网={断网} 待同步={待同步} 上次成功={上次成功} 错误={错误} 现在={现在} 在同步={在同步} onOpen={onSyncInfo} /></>}
      onRefresh={onSync}>
      {!已装 && !关了装提示 && <InstallHint os={os} onClose={() => set关了装提示(true)} />}
      {没同步上 > 0 && (
        <button className="m-callout m-callout-btn" onClick={onUnsynced}>
          <ExclamationCircleFilled /> 有 {没同步上} 条跟进没同步上，点开复制后重新记<RightOutlined />
        </button>
      )}
      <div className="m-stats">
        <div className={`m-stat${今天.过期.length ? " is-danger" : ""}`}><b>{今天.过期.length}</b><span>已过期</span></div>
        <div className="m-stat"><b>{今天.今天.length}</b><span>今天要跟</span></div>
        <div className="m-stat"><b>{今天.之后.length}</b><span>之后 3 天</span></div>
      </div>
      {今天.过期.length > 0 && <PlanGroup 标题="已过期" 客户们={今天.过期} 现在={现在} onOpen={onOpen} 过期 />}
      <PlanGroup 标题="今天" 客户们={今天.今天} 现在={现在} onOpen={onOpen} 空="今天没有要跟的，去「客户」里看看" />
      {今天.之后.length > 0 && <PlanGroup 标题="之后 3 天" 客户们={今天.之后} 现在={现在} onOpen={onOpen} />}
    </Page>
  );
}

function PlanGroup({ 标题, 客户们, 现在, onOpen, 过期, 空 }: { 标题: string; 客户们: 客户视图[]; 现在: number; onOpen: (id: string) => void; 过期?: boolean; 空?: string }) {
  return (
    <section className="m-group">
      <div className="m-group-h">{标题}<span>{客户们.length || ""}</span></div>
      {客户们.length === 0 ? <div className="m-empty">{空}</div> : (
        <div className="m-list">
          {客户们.map((c) => (
            <button key={c.id} className="m-row" onClick={() => onOpen(c.id)}>
              <Avatar name={c.name} />
              <div className="m-row-main">
                <div className="m-row-t"><span className="m-ellipsis">{c.name}</span><span className="m-flag">{国旗(c.country)}</span></div>
                <div className="m-row-s m-clamp2">{c.计划!.subject}</div>
                <div className="m-row-m">
                  <span className={过期 ? "is-danger" : ""}><CalendarOutlined /> {过期 ? `过期 · ${相对时间(c.计划!.at, 现在)}` : 相对时间(c.计划!.at, 现在)}</span>
                  {c.计划!.method && <span>{c.计划!.method}</span>}
                </div>
              </div>
              <RightOutlined className="m-chev" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/* ====================================================================== 客户 */

function CustomersScreen({ os, 客户们, 我, 现在, 断网, 名, onOpen, onMe, onSync, onNew, onScan }: { os: 系统; 客户们: 客户视图[]; 我: string; 现在: number; 断网: boolean; 名: string; onOpen: (id: string) => void; onMe: () => void; onSync: () => Promise<void>; onNew: () => void; onScan: (f: File) => void }) {
  const [q, setQ] = useState("");
  const [段, set段] = useState<"mine" | "pool">("mine");
  const 手上 = 客户们.filter((c) => !c.公海), 公海 = 客户们.filter((c) => c.公海);
  // 老板看得到别人的客户：这一栏叫「团队客户」；业务员只有自己的，叫「我的客户」
  const 是老板 = 手上.some((c) => c.salesOwnerId && c.salesOwnerId !== 我);
  const 列表 = useMemo(() => {
    const 源 = q.trim() ? 客户们 : 段 === "mine" ? 手上 : 公海;
    return 搜(源, q).sort((a, b) => (b.上次跟进 ?? 0) - (a.上次跟进 ?? 0));
  }, [q, 段, 客户们, 手上, 公海]);
  // 一次最多画 300 行：几千位客户时也不卡；要找的用搜索
  const 画 = 列表.slice(0, 300);
  const 扫 = usePickPhoto(onScan);
  return (
    <Page os={os} 标题="客户" onRefresh={onSync}
      右={<><ScanButton onClick={扫.拍} /><button className="m-icon-btn m-add" onClick={onNew} aria-label="新建客户" data-testid="m-new-customer"><PlusOutlined /></button><button className="m-me" onClick={onMe} aria-label="我的">{简称(名 || "我")}</button></>}
      吸顶={
        <div className="m-search-wrap">
          <label className="m-search">
            <SearchOutlined />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="公司、联系人、国家、电话" enterKeyHint="search" />
            {q && <button onClick={() => setQ("")} aria-label="清空"><CloseCircleFilled /></button>}
          </label>
          {!q && (
            <div className="m-seg" role="tablist">
              <button role="tab" aria-selected={段 === "mine"} className={段 === "mine" ? "is-on" : ""} onClick={() => set段("mine")}>{是老板 ? "团队客户" : "我的客户"} <span>{手上.length}</span></button>
              <button role="tab" aria-selected={段 === "pool"} className={段 === "pool" ? "is-on" : ""} onClick={() => set段("pool")}>公海 <span>{公海.length}</span></button>
              <i className="m-seg-thumb" style={{ transform: `translateX(${段 === "mine" ? 0 : 100}%)` }} />
            </div>
          )}
          {扫.点过 && 扫.换浏览器 && <BrowserTip 话={扫.换浏览器} />}
          {扫.没开 && <NoCameraTip on相册={扫.相册} on关={扫.关} />}
        </div>
      }>
      {断网 && <div className="m-offline-note"><DisconnectOutlined /> 离线：看到的是上次同步的内容</div>}
      {q && <div className="m-group-h m-group-h-solo">找到 {列表.length} 位</div>}
      {列表.length === 0 ? (
        <div className="m-empty m-empty-big">{q ? <>没有找到「{q}」<br /><small>手机上只搜得到你能看的客户</small></> : 段 === "pool" ? "公海里没有客户" : <>还没有客户<br /><small>点右上角 + 新建，电脑上建的也会同步过来</small></>}</div>
      ) : (
        <div className="m-list m-list-flat">
          {画.map((c) => (
            <button key={c.id} className="m-row" onClick={() => onOpen(c.id)}>
              <Avatar name={c.name} />
              <div className="m-row-main">
                <div className="m-row-t"><span className="m-ellipsis">{c.name}</span>{c.公海 && q ? <span className="m-tag m-tag-pool">公海</span> : null}</div>
                <div className="m-row-m">
                  {c.country && <span>{国旗(c.country)} {c.country}</span>}
                  {c.联系人[0]?.name && <span>{c.联系人[0].name}</span>}
                  {是老板 && c.负责人 && c.负责人 !== "我" && !c.公海 && <span>{c.负责人}</span>}
                  <span>{c.上次跟进 ? 相对时间(c.上次跟进, 现在) : "没跟进过"}</span>
                </div>
              </div>
              <StatusTag s={c.status} />
            </button>
          ))}
        </div>
      )}
      {列表.length > 画.length && <div className="m-foot-note">还有 {列表.length - 画.length} 位，用上面的搜索找</div>}
    </Page>
  );
}

/* ====================================================================== 详情 */

const 号码 = (s: string) => s.replace(/[^\d+]/g, "");
function DetailScreen({ os, c, 现在, 断网, 来自, 业务, 待同步, onBack, onRecord, onNewOpp }: { os: 系统; c: 客户视图; 现在: number; 断网: boolean; 来自: string; 业务: BusinessConfig; 待同步: string[]; onBack: () => void; onRecord: () => void; onNewOpp: () => void }) {
  const 主 = c.联系人[0];
  const 电话 = 主?.phone || c.phone;
  const 邮箱 = 主?.email || c.email;
  const 阶 = c.商机 ? 阶段表.indexOf(c.商机.stage) : -1;
  const 今早 = new Date(现在); 今早.setHours(0, 0, 0, 0);
  const 过期 = c.计划 && c.计划.at < 今早.getTime();
  return (
    <Page os={os} 标题={c.name} 返回={onBack} 返回字={来自}
      底部={<div className="m-bottom-bar"><button className="m-btn m-btn-block" onClick={onRecord}><EditOutlined /> {c.公海 ? "领取并记跟进" : "记一笔跟进"}</button></div>}>
      <div className="m-hero">
        <Avatar name={c.name} size={60} />
        <div className="m-hero-t">
          <div className="m-hero-tags"><StatusTag s={c.status} />{c.公海 && <span className="m-tag m-tag-pool">公海</span>}{c.country && <span className="m-hero-country">{国旗(c.country)} {c.country}</span>}</div>
          {主 && <div className="m-hero-sub">{主.name}{主.title ? ` · ${主.title}` : ""}</div>}
          {c.负责人 && c.负责人 !== "我" && !c.公海 && <div className="m-hero-sub">负责人：{c.负责人}</div>}
        </div>
      </div>

      <div className="m-actions">
        <a className={电话 ? "" : "is-off"} href={电话 ? `tel:${号码(电话)}` : undefined}><span><PhoneOutlined /></span>电话</a>
        <a className={c.whatsapp ? "" : "is-off"} href={c.whatsapp ? `https://wa.me/${号码(c.whatsapp).replace(/^\+/, "")}` : undefined} target="_blank" rel="noreferrer"><span><WhatsAppOutlined /></span>WhatsApp</a>
        <a className={邮箱 ? "" : "is-off"} href={邮箱 ? `mailto:${邮箱}` : undefined}><span><MailOutlined /></span>邮件</a>
        <button onClick={onRecord} className="is-brand"><span><EditOutlined /></span>记一笔</button>
      </div>

      {/* 记跟进 = 领取（2026-10-19）：记一笔就领过来；断网时先排着，联网后替你领（被别人先领走的进「没同步上」） */}
      {c.公海 && <div className="m-callout">{断网 ? "这是公海客户，联网后会替你领取。" : "公海客户：记一笔跟进就领取过来，归你跟进。"}</div>}

      {c.计划 && (
        <section className="m-card">
          <div className="m-card-h">下次跟进</div>
          <div className="m-plan-when">
            <span className={`m-plan-date${过期 ? " is-danger" : ""}`}><CalendarFilled /> {过期 ? `已过期 · ${相对时间(c.计划.at, 现在)}` : 相对时间(c.计划.at, 现在)}</span>
            {c.计划.method && <span className="m-plan-method">{c.计划.method}</span>}
          </div>
          <div className="m-plan-s">{c.计划.subject}</div>
        </section>
      )}

      {c.商机 ? (
        <section className="m-card">
          <div className="m-card-h">商机<span className="m-amount">{金额(c.商机.amount, c.商机.currency)}</span></div>
          <div className="m-opp-name">{c.商机.name}{待同步.includes(c.商机.id) && <em className="m-pending"><CloudSyncOutlined /> 待同步</em>}</div>
          {阶 >= 0 && (
            <>
              <div className="m-stages">{阶段表.map((s, i) => <i key={s} className={i <= 阶 ? "is-on" : ""} />)}</div>
              <div className="m-stage-l"><b>{stageLabel(业务, c.商机.stage)}</b><span>第 {阶 + 1} / {阶段表.length} 步</span></div>
            </>
          )}
          {!c.公海 && <button className="m-text-btn m-card-more" onClick={onNewOpp} data-testid="m-new-opp"><PlusOutlined /> 再建一个商机</button>}
        </section>
      ) : !c.公海 && (
        <section className="m-card">
          <div className="m-card-h">商机</div>
          <button className="m-btn m-btn-ghost m-btn-block" onClick={onNewOpp} data-testid="m-new-opp"><PlusOutlined /> 新建商机</button>
        </section>
      )}

      <section className="m-card">
        <div className="m-card-h">跟进记录<span>{c.跟进.length} 条</span></div>
        {c.跟进.length === 0 ? <p className="m-note">还没有跟进记录</p> : (
          <ol className="m-timeline">
            <AnimatePresence initial={false}>
              {c.跟进.slice(0, 50).map((x) => (
                <motion.li key={x.id} layout initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={弹簧}>
                  <i style={{ background: 类型(x.type).color }} />
                  <div className="m-tl-h"><b>{类型(x.type).label}</b><span>{相对时间(x.at, 现在)} · {x.by}</span>
                    {x.待同步 && <em className="m-pending"><CloudSyncOutlined /> 待同步</em>}
                  </div>
                  <p>{x.content}</p>
                  {x.关联 && <div className="m-tl-link"><LinkOutlined /> {x.关联}</div>}
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
        {c.跟进.length > 50 && <div className="m-foot-note">更早的 {c.跟进.length - 50} 条请在电脑上看</div>}
      </section>

      {c.联系人.length > 0 && (
        <section className="m-card">
          <div className="m-card-h">联系人<span>{c.联系人.length}</span></div>
          {c.联系人.map((p) => (
            <div key={p.id} className="m-contact">
              <Avatar name={p.name} size={34} />
              <div className="m-row-main"><div className="m-row-t">{p.name}</div><div className="m-row-m">{p.title && <span>{p.title}</span>}{p.email && <span className="m-ellipsis">{p.email}</span>}</div></div>
              {p.phone && <a className="m-icon-btn" href={`tel:${号码(p.phone)}`} aria-label={`给 ${p.name} 打电话`}><PhoneOutlined /></a>}
              {p.email && <a className="m-icon-btn" href={`mailto:${p.email}`} aria-label={`给 ${p.name} 发邮件`}><MailOutlined /></a>}
            </div>
          ))}
        </section>
      )}

      {c.remark && <section className="m-card"><div className="m-card-h">备注</div><p className="m-note">{c.remark}</p></section>}
      <div className="m-foot-note">改资料请在电脑上操作；公海客户记一笔跟进就领取过来</div>
    </Page>
  );
}

/* ====================================================================== 记一笔 */

function 计划标题(字: string) {
  const 首句 = 字.trim().split(/[，。！？,.!?\n]/)[0].slice(0, 20);
  return 首句 ? `接着跟进：${首句}` : "接着跟进";
}

function RecordSheet({ c, os, 我, 断网, 业务, onCancel, onSave }: { c: 客户视图; os: 系统; 我: string; 断网: boolean; 业务: BusinessConfig; onCancel: () => void; onSave: (x: Omit<同步.记跟进输入, "customerId">) => void }) {
  // 有 WhatsApp 号的（外贸客户多半是）默认记成 WhatsApp；只有微信号的默认微信沟通；都没有的照旧默认消息（2026-10-16 / 10-19）
  const [t, setT] = useState<(typeof 同步.手机跟进类型)[number]>(c.whatsapp ? "WHATSAPP" : c.wechat ? "WECHAT" : "SMS");
  // 关联商机 / 订单（2026-10-19 客户反馈第 8 条）：和电脑上那一格一样，外贸模版商机、订单两组都列，通用模版只有商机
  const 挂订单 = 外贸订单(业务);
  const 订单们 = 挂订单 ? c.可关联.订单 : [];
  const 商机们 = c.可关联.商机;
  const [关联, set关联] = useState("");
  const [字, set字] = useState("");
  const [下次, set下次] = useState<"none" | "1" | "3" | "7" | "pick">("3");
  const [日期, set日期] = useState(() => { const d = new Date(Date.now() + 3 * 86400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  const 我的计划 = c.计划 && c.计划.ownerId === 我 ? c.计划 : null;
  const [完成, set完成] = useState(true);
  const 框 = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const x = setTimeout(() => 框.current?.focus(), 380); return () => clearTimeout(x); }, []);

  const 存 = () => {
    const 内容 = 字.trim();
    if (!内容) return;
    let 时间: number | null = null;
    if (下次 === "pick") { const [y, m, d] = 日期.split("-").map(Number); 时间 = new Date(y, m - 1, d, 10).getTime(); }
    else if (下次 !== "none") { const d = new Date(); d.setHours(10, 0, 0, 0); 时间 = d.getTime() + Number(下次) * 86400_000; }
    onSave({ type: t, content: 内容, 下次: 时间 ? { 时间, 主题: 计划标题(内容), 方式: 类型(t).label } : null, 完成计划: 我的计划 && 完成 ? 我的计划.id : null, 关联: 关联 || null });
  };
  const 可存 = 字.trim().length > 0;

  return (
    <div className="m-record">
      <div className="m-sheet-h">
        <button className="m-text-btn" onClick={onCancel}>{os === "ios" ? "取消" : <CloseOutlined />}</button>
        <b>{c.公海 ? "领取并记跟进" : "记一笔跟进"}</b>
        <button className="m-text-btn is-strong" disabled={!可存} onClick={存}>保存</button>
      </div>
      <div className="m-record-who"><Avatar name={c.name} size={28} /><span className="m-ellipsis">{c.name}</span><span className="m-flag">{国旗(c.country)}</span></div>
      {c.公海 && <div className="m-callout" data-testid="m-record-pool">{断网 ? "这是公海客户，联网后会替你领取" : "这是公海客户，保存后归你跟进"}</div>}
      <div className="m-chips" role="radiogroup" aria-label="跟进方式">
        {类型表.map((x) => (
          <button key={x.value} role="radio" aria-checked={t === x.value} className={t === x.value ? "is-on" : ""} onClick={() => setT(x.value)}>
            <i style={{ background: x.color }} />{x.短}
          </button>
        ))}
      </div>
      <div className="m-textarea">
        <textarea ref={框} value={字} onChange={(e) => set字(e.target.value)} rows={5} maxLength={5000} placeholder="聊了什么？结果怎样？" />
        <div className="m-textarea-tip"><AudioOutlined /> 懒得打字？按键盘上的话筒说</div>
      </div>
      {(商机们.length > 0 || 订单们.length > 0) && (
        <>
          <div className="m-field-l">{挂订单 ? "关联商机 / 订单" : "关联商机"}</div>
          <select className="m-date m-select" value={关联} onChange={(e) => set关联(e.target.value)} aria-label={挂订单 ? "关联商机 / 订单" : "关联商机"} data-testid="m-record-link">
            <option value="">不关联</option>
            {订单们.length > 0 && <optgroup label="订单">{订单们.map((o) => <option key={o.id} value={`${订单前缀}${o.id}`}>订单 {o.no}</option>)}</optgroup>}
            {订单们.length > 0
              ? 商机们.length > 0 && <optgroup label="商机">{商机们.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>
              : 商机们.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </>
      )}
      {我的计划 && (
        <label className="m-check">
          <input type="checkbox" checked={完成} onChange={(e) => set完成(e.target.checked)} />
          <span>顺手完成计划「{我的计划.subject}」</span>
        </label>
      )}
      <div className="m-field-l">下次跟进</div>
      <div className="m-chips m-chips-plain">
        {([["none", "不设"], ["1", "明天"], ["3", "3 天后"], ["7", "下周"], ["pick", "选日期"]] as const).map(([k, l]) => (
          <button key={k} className={下次 === k ? "is-on" : ""} onClick={() => set下次(k)}>{l}</button>
        ))}
      </div>
      {下次 === "pick" && <input className="m-date" type="date" value={日期} onChange={(e) => set日期(e.target.value)} />}
      <button className="m-btn m-btn-block m-record-save" disabled={!可存} onClick={存}>保存</button>
      <div className="m-foot-note"><LockOutlined /> 加密后同步到你的电脑，服务器看不到内容</div>
    </div>
  );
}

/* ====================================================================== 新建客户 / 商机（2026-10-19 客户反馈第 7 条） */

/**
 * 只放必填和常用几格（名字、联系方式、国家、来源）；推荐人、等级、官网这些在电脑上补。
 * 外贸：电话、WhatsApp、邮箱至少一个；通用模版只问名字和电话（和电脑上的新建框同一套规矩，lib/mobile/sync.ts 新建客户 里再核一次）
 *
 * 扫名片（2026-10-19）：从客户页相机图标进来时带着 图，一打开就认；表单顶上「拍名片自动填」只补空格。
 * 认出来的微信、官网、备注（职位、地址、其他电话…）这时才出现；拿不准的标黄，改过就不黄了。
 * 扫过的这一张存完不跳走，给「再扫一张」：展会上一张接一张。来源记住上一次（这次打开 App 期间）
 */
function NewCustomerSheet({ os, 业务, 图, 来源, 找老, onCancel, onSave, onRecordFor }: {
  os: 系统; 业务: BusinessConfig; 图?: File; 来源: string; 找老: (phone: string, email: string) => 客户视图 | undefined;
  onCancel: () => void; onSave: (x: 同步.新建客户输入, 留着: boolean) => Promise<string | null>; onRecordFor: (id: string) => void;
}) {
  const 外贸 = 业务.template === "trade";
  const 空 = (): 名片表单 & { source: string } => ({ ...空名片表单(), source: 来源 });
  const [填, set填] = useState(空);
  const [黄, set黄] = useState<Set<keyof 名片表单>>(new Set());
  const [候选, set候选] = useState<{ 名字: string[]; wa: string | null }>({ 名字: [], wa: null });
  const [扫过, set扫过] = useState(Boolean(图));
  const [存好, set存好] = useState<string | null>(null);
  const [错, set错] = useState<string | null>(null);
  const [存着, set存着] = useState(false);
  const 名框 = useRef<HTMLInputElement>(null);
  const 填ref = useRef(填);
  useEffect(() => { 填ref.current = 填; });
  const 扫 = useCardScan(外贸, (法) => {
    // 已经填了的格子不覆盖（次入口：先手填了几格再拍）；第一次从相机进来时表单是空的，等于全填
    const { 填: 新, 补了 } = 只补空格(填ref.current, 法.填);
    set填((f) => ({ ...新, source: f.source }));
    set黄(new Set(法.黄.filter((k) => 补了.includes(k))));
    set候选({ 名字: 法.名字候选, wa: 法.whatsapp建议 });
    set错(null);
  });
  // 从相机图标进来：一打开就认；手工「+」进来：聚焦名字格。只在打开时做一次
  // （开发模式下 effect 会跑两遍：照片现在要传服务器认，别传两次）
  const 认过 = useRef(false);
  useEffect(() => {
    if (图) { if (!认过.current) { 认过.current = true; void 扫.认(图); } return; }
    const x = setTimeout(() => 名框.current?.focus(), 380);
    return () => clearTimeout(x);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const 用照片 = (f: File) => { set扫过(true); void 扫.认(f); };
  const 改 = (k: keyof 名片表单 | "source") => (e: { target: { value: string } }) => {
    set填((f) => ({ ...f, [k]: e.target.value })); set错(null);
    if (k !== "source") set黄((h) => { if (!h.has(k)) return h; const n = new Set(h); n.delete(k); return n; });
  };
  const 设 = (k: keyof 名片表单, v: string) => { set填((f) => ({ ...f, [k]: v })); set黄((h) => { const n = new Set(h); n.delete(k); return n; }); };
  const 有联系 = Boolean(填.phone?.trim() || (外贸 && (填.whatsapp?.trim() || 填.email?.trim())));
  const 可存 = 填.name.trim().length > 0 && 有联系 && !存着 && 扫.态?.阶段 !== "认";
  const 存 = async () => {
    if (!可存) return;
    set存着(true);
    const 话 = await onSave(外贸 ? 填 : { name: 填.name, phone: 填.phone, remark: 填.remark }, 扫过);
    set存着(false);
    if (话) { set错(话); return; }
    if (扫过) set存好(填.name.trim());
  };
  // 再扫一张：先开相机（要在点击里），拍到了再清表单；来源留着
  const 再扫 = usePickPhoto((f) => {
    set填((x) => ({ ...空(), source: x.source })); set黄(new Set()); set候选({ 名字: [], wa: null }); set存好(null); set错(null);
    用照片(f);
  });
  const 黄的 = (k: keyof 名片表单) => (黄.has(k) ? " is-check" : "");
  const 老 = 错 ? 找老(填.phone, 填.email) : undefined;
  if (存好 !== null) {
    return (
      <div className="m-record m-scan-saved" data-testid="m-scan-saved">
        <div className="m-scan-saved-ok"><CheckCircleFilled /></div>
        <b>已存好「{存好}」</b>
        <p>{填.source ? `来源：${填.source}，下一张会自动带上` : "下一张也从相机直接填"}</p>
        {再扫.点过 && 再扫.换浏览器 && <BrowserTip 话={再扫.换浏览器} />}
        {再扫.没开 && <NoCameraTip />}
        <button className="m-btn m-btn-block" data-testid="m-scan-again" onClick={再扫.拍}><CameraOutlined /> 再扫一张</button>
        <button className="m-scan-take is-ghost" data-testid="m-scan-again-album" onClick={再扫.相册}><PictureOutlined /> 从相册选</button>
        <button className="m-btn m-btn-block m-btn-ghost" onClick={onCancel}>完成</button>
      </div>
    );
  }
  return (
    <div className="m-record" data-testid="m-new-customer-sheet">
      <div className="m-sheet-h">
        <button className="m-text-btn" onClick={onCancel}>{os === "ios" ? "取消" : <CloseOutlined />}</button>
        <b>新建{业务.customer}</b>
        <button className="m-text-btn is-strong" disabled={!可存} onClick={() => void 存()}>保存</button>
      </div>
      <ScanBar 态={扫.态} onPhoto={用照片} on换语言={扫.换语言} on再试={扫.再试} />
      <form className="m-form m-form-sheet" onSubmit={(e) => { e.preventDefault(); void 存(); }}>
        <label className={黄的("name")}><span>名字</span><input ref={名框} value={填.name} onChange={改("name")} maxLength={100} placeholder={外贸 ? "公司名或联系人" : "姓名"} autoComplete="off" /></label>
        {候选.名字.length > 0 && (
          <div className="m-scan-alt">换成：{候选.名字.map((x) => <button type="button" key={x} onClick={() => { 设("name", x); set候选((c) => ({ ...c, 名字: c.名字.filter((y) => y !== x).concat(填.name ? [填.name] : []) })); }}>{x}</button>)}</div>
        )}
        <label className={黄的("phone")}><span>电话{外贸 ? "" : "（必填）"}</span><input value={填.phone} onChange={改("phone")} type="tel" inputMode="tel" maxLength={40} placeholder={外贸 ? "选填，可以带 +86 / +44" : "手机号"} autoComplete="off" /></label>
        {外贸 && (
          <>
            <label className={黄的("whatsapp")}><span>WhatsApp</span><input value={填.whatsapp} onChange={改("whatsapp")} type="tel" inputMode="tel" maxLength={40} placeholder="选填，带国家区号" autoComplete="off" /></label>
            {候选.wa && !填.whatsapp && <div className="m-scan-alt">名片上没写 WhatsApp：<button type="button" onClick={() => 设("whatsapp", 候选.wa!)}>用手机号 {候选.wa}</button></div>}
            <label className={黄的("email")}><span>邮箱</span><input value={填.email} onChange={改("email")} type="email" inputMode="email" maxLength={200} placeholder="选填" autoComplete="off" autoCapitalize="none" /></label>
            <p className="m-form-tip">电话、WhatsApp、邮箱至少填一个；没有电话就用 WhatsApp 或邮箱认人</p>
            {(扫过 || 填.wechat) && <label className={黄的("wechat")}><span>微信</span><input value={填.wechat} onChange={改("wechat")} maxLength={60} placeholder="选填" autoComplete="off" autoCapitalize="none" /></label>}
            {(扫过 || 填.website) && <label className={黄的("website")}><span>官网</span><input value={填.website} onChange={改("website")} inputMode="url" maxLength={200} placeholder="选填" autoComplete="off" autoCapitalize="none" /></label>}
            <label className={黄的("country")}><span>国家</span><input value={填.country} onChange={改("country")} list="m-countries" maxLength={60} placeholder="选一个，或直接填" autoComplete="off" /></label>
            <datalist id="m-countries">{国家候选.flatMap((g) => g.国家).map((x) => <option key={x} value={x} />)}</datalist>
            <div className="m-field-l">来源</div>
            <div className="m-chips m-chips-plain">
              {业务.sources.map((x) => (
                <button type="button" key={x} className={填.source === x ? "is-on" : ""} onClick={() => set填((f) => ({ ...f, source: f.source === x ? "" : x }))}>{x}</button>
              ))}
            </div>
            <input className="m-scan-source" value={业务.sources.includes(填.source) ? "" : 填.source} onChange={改("source")} maxLength={40} placeholder="或者填展会名，比如 2026 迪拜展" aria-label="来源" autoComplete="off" />
          </>
        )}
        {(扫过 || 填.remark) && (
          <label className={黄的("remark")}><span>备注</span><textarea value={填.remark} onChange={改("remark")} maxLength={2000} rows={Math.min(6, Math.max(2, 填.remark.split("\n").length))} placeholder="职位、地址、其他电话" /></label>
        )}
        {错 && <div className="m-form-err" role="alert">{错}</div>}
        {老 && <button type="button" className="m-btn m-btn-block m-btn-ghost" onClick={() => onRecordFor(老.id)}>改成给「{老.name}」记一笔跟进</button>}
        <button className="m-btn m-btn-block m-record-save" type="submit" disabled={!可存}>保存</button>
      </form>
      <div className="m-foot-note"><LockOutlined /> 归你名下，加密后同步到你的电脑</div>
    </div>
  );
}

function NewOppSheet({ c, os, 业务, onCancel, onSave }: { c: 客户视图; os: 系统; 业务: BusinessConfig; onCancel: () => void; onSave: (x: Omit<同步.新建商机输入, "customerId">) => Promise<string | null> }) {
  const [名, set名] = useState("");
  const [额, set额] = useState("");
  const [阶, set阶] = useState<string>(同步.手机商机阶段[0]);
  const [错, set错] = useState<string | null>(null);
  const [存着, set存着] = useState(false);
  const 名框 = useRef<HTMLInputElement>(null);
  useEffect(() => { const x = setTimeout(() => 名框.current?.focus(), 380); return () => clearTimeout(x); }, []);
  const 数 = 额.trim() === "" ? 0 : Number(额.replace(/[,，\s]/g, ""));
  const 可存 = 名.trim().length > 0 && Number.isFinite(数) && 数 >= 0 && !存着;
  const 存 = async () => {
    if (!可存) return;
    set存着(true);
    const 话 = await onSave({ name: 名, amount: 数, stage: 阶 });
    set存着(false);
    if (话) set错(话);
  };
  return (
    <div className="m-record" data-testid="m-new-opp-sheet">
      <div className="m-sheet-h">
        <button className="m-text-btn" onClick={onCancel}>{os === "ios" ? "取消" : <CloseOutlined />}</button>
        <b>新建商机</b>
        <button className="m-text-btn is-strong" disabled={!可存} onClick={() => void 存()}>保存</button>
      </div>
      <div className="m-record-who"><Avatar name={c.name} size={28} /><span className="m-ellipsis">{c.name}</span><span className="m-flag">{国旗(c.country)}</span></div>
      <form className="m-form m-form-sheet" onSubmit={(e) => { e.preventDefault(); void 存(); }}>
        <label><span>商机名称</span><input ref={名框} value={名} onChange={(e) => { set名(e.target.value); set错(null); }} maxLength={100} placeholder="例如：工矿灯 2000 套" autoComplete="off" /></label>
        <label><span>金额（{业务.currency}）</span><input value={额} onChange={(e) => { set额(e.target.value); set错(null); }} inputMode="decimal" maxLength={20} placeholder="0" autoComplete="off" /></label>
        <div className="m-field-l">阶段</div>
        <div className="m-chips m-chips-plain" role="radiogroup" aria-label="商机阶段">
          {同步.手机商机阶段.map((x) => (
            <button type="button" role="radio" aria-checked={阶 === x} key={x} className={阶 === x ? "is-on" : ""} onClick={() => set阶(x)}>{stageLabel(业务, x)}</button>
          ))}
        </div>
        {错 && <div className="m-form-err" role="alert">{错}</div>}
        <button className="m-btn m-btn-block m-record-save" type="submit" disabled={!可存}>保存</button>
      </form>
      <div className="m-foot-note">{外贸订单说法(业务)}</div>
    </div>
  );
}
const 外贸订单说法 = (b: BusinessConfig) => (b.template === "trade" ? "客户确认、转订单请在电脑上操作" : "赢单签约请在电脑上操作");

/* ====================================================================== 我的、没同步上的 */

function MeSheet({ 账号, 团队名, 断网, 待同步, 在同步, 上次成功, 错误, 现在, 没同步上, 云, 团队, 设备版本, onSync, onUnsynced, onLogout }: {
  账号: 账号 | null; 团队名: string; 断网: boolean; 待同步: number; 在同步: boolean; 上次成功: number | null; 错误: string | null; 现在: number;
  没同步上: number; 云: 同步.传输 | null; 团队: 同步.手机团队 | null; 设备版本: number; onSync: () => void; onUnsynced: () => void; onLogout: () => void;
}) {
  const [确认退出, set确认退出] = useState(false);
  const 详 = 同步条({ 断网, 待同步, 在同步, 上次成功, 错误, 现在 }).详;
  // 我的设备（2026-10-15）：本人在团队里的电脑和手机；授权了新设备（设备版本 +1）就重新取
  const [设备, set设备] = useState<{ 设备: 连.我的一台[]; 上限: number } | null>(null);
  useEffect(() => {
    if (!云 || !团队) return;
    let 停 = false;
    连.我的设备(云, 团队).then((r) => { if (!停) set设备(r); }, () => undefined);
    return () => { 停 = true; };
  }, [云, 团队, 设备版本]);
  return (
    <div className="m-me-sheet">
      <div className="m-me-card">
        <span className="m-avatar" style={{ width: 52, height: 52, background: "var(--brand-bg)", color: "var(--brand-deep)", fontSize: 19 }}>{简称(账号?.name || "我")}</span>
        <div><b>{账号?.name || "我"}</b>{账号?.contact && <span>{账号.contact}</span>}{团队名 && <span>{团队名}</span>}</div>
      </div>
      <div className="m-list m-list-inset">
        <div className="m-kv"><CloudSyncOutlined /><span>同步</span><b><SyncChip 断网={断网} 待同步={待同步} 上次成功={上次成功} 错误={错误} 现在={现在} 在同步={在同步} /></b></div>
        <div className="m-kv"><LockOutlined /><span>加密</span><b>端到端，服务器看不到内容</b></div>
        {详 && <div className="m-kv m-kv-col" data-testid="m-sync-why"><span>{详.原因}{详.怎么办}</span></div>}
        <button className="m-kv m-kv-btn" onClick={onSync} disabled={在同步}>立即同步</button>
        {没同步上 > 0 && <button className="m-kv m-kv-btn" onClick={onUnsynced}>没同步上的记录（{没同步上}）</button>}
      </div>
      {设备 && (
        <>
          <div className="m-list-h">我的设备 {设备.设备.length} / {设备.上限}</div>
          <div className="m-list m-list-inset" data-testid="m-devices">
            {设备.设备.map((d) => (
              <div key={d.device} className="m-kv">
                {d.种类 === "电脑" ? <LaptopOutlined /> : <MobileOutlined />}
                <span className="m-kv-name">{d.label}{d.这台 ? "（这台）" : ""}</span>
                <b>{d.最近同步 ? 相对时间(Date.parse(d.最近同步)) : ""}</b>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="m-list m-list-inset">
        {!确认退出 ? (
          <button className="m-kv m-kv-btn is-danger" onClick={() => set确认退出(true)}>退出登录</button>
        ) : (
          <>
            <div className="m-kv m-kv-col"><span>退出后手机上的客户数据会清掉{待同步 ? `，还有 ${待同步} 条没同步上的记录也会丢` : ""}。下次登录要在电脑上重新授权。</span></div>
            <button className="m-kv m-kv-btn is-danger" onClick={onLogout}>确认退出</button>
            <button className="m-kv m-kv-btn" onClick={() => set确认退出(false)}>算了</button>
          </>
        )}
      </div>
      <div className="m-foot-note">新电脑、新手机登录这个账号后，在这里或电脑上点「允许」就能连上（最多 {设备?.上限 ?? 3} 台）。在电脑上「设置 → 团队 → 我的设备」里可以移除不用的设备</div>
    </div>
  );
}

/** 点今天页的同步状态条：为什么没同步、该怎么办、上次成功是什么时候 */
function SyncSheet({ 断网, 待同步, 在同步, 上次成功, 错误, 现在, onSync }: {
  断网: boolean; 待同步: number; 在同步: boolean; 上次成功: number | null; 错误: string | null; 现在: number; onSync: () => void;
}) {
  const x = 同步条({ 断网, 待同步, 在同步, 上次成功, 错误, 现在 });
  return (
    <div className="m-me-sheet" data-testid="m-sync-sheet">
      <div className="m-sheet-h"><span /><b>{x.详?.标题 ?? "同步"}</b><span /></div>
      {x.详 ? (
        <div className="m-sync-why">
          <p className="m-note">{x.详.原因}</p>
          <p className="m-note">{x.详.怎么办}</p>
        </div>
      ) : <div className="m-sync-why"><p className="m-note">同步恢复了。</p></div>}
      <div className="m-list m-list-inset">
        <div className="m-kv"><CloudSyncOutlined /><span>现在</span><b><SyncChip 断网={断网} 待同步={待同步} 上次成功={上次成功} 错误={错误} 现在={现在} 在同步={在同步} /></b></div>
        <div className="m-kv"><CheckCircleFilled /><span>上次同步成功</span><b>{上次成功 ? 相对时间(上次成功, 现在) : "还没有"}</b></div>
        <button className="m-kv m-kv-btn" onClick={onSync} disabled={在同步}>{在同步 ? "正在试…" : "再试一次"}</button>
      </div>
    </div>
  );
}

function UnsyncedSheet({ 列, 说, on处理 }: { 列: { key: string; 来自: "被拒" | "遗留"; i: number; content: string; customer: string; at: number; 原因: string }[]; 说: (s: string, 图?: ReactNode) => void; on处理: (x: { 来自: "被拒" | "遗留"; i: number }) => void }) {
  return (
    <div className="m-me-sheet">
      <div className="m-sheet-h"><span /><b>没同步上的跟进</b><span /></div>
      <p className="m-note" style={{ padding: "0 4px 12px" }}>这些记录没进任何人的电脑（客户转给了别人、被删了，或者登录失效前没来得及传）。复制下来，在对的客户上重新记一笔或重新建。</p>
      {列.length === 0 && <div className="m-empty">都处理完了</div>}
      {列.map((x) => (
        <section key={x.key} className="m-card">
          <div className="m-card-h">{x.customer || "客户"}<span>{x.at ? 相对时间(x.at) : ""}</span></div>
          <p className="m-note">{x.content}</p>
          <div className="m-row-m"><span>{x.原因}</span></div>
          <div className="m-unsynced-btns">
            <button className="m-btn m-btn-sm m-btn-ghost" onClick={() => { void navigator.clipboard?.writeText(x.content).then(() => 说("已复制", <CopyOutlined />), () => 说("复制不了，长按文字手动复制")); }}><CopyOutlined /> 复制</button>
            <button className="m-btn m-btn-sm m-btn-ghost" onClick={() => on处理(x)}>已处理</button>
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * 本人的新电脑 / 新手机来要授权（2026-10-15，0.46.17）。话和电脑上的授权框（components/MobileAuthPrompt）对齐：
 * 传什么、我们看不到、在哪移除；再加配对数字——和那台屏幕上的对一下，对不上别点允许。
 * 新电脑在这里批准的话管不了团队（老板的管理钥匙不在手机上），那台的设置页会写明。
 */
function ApproveSheet({ x, onAllow, onDeny, onLater }: { x: 连.待授权; onAllow: () => Promise<void>; onDeny: () => Promise<void>; onLater: () => void }) {
  const [忙, set忙] = useState<"允许" | "拒绝" | null>(null);
  const 做 = async (哪个: "允许" | "拒绝") => { set忙(哪个); try { await (哪个 === "允许" ? onAllow() : onDeny()); } finally { set忙(null); } };
  return (
    <div className="m-me-sheet" data-testid="m-approve">
      <div className="m-sheet-h"><span /><b>{x.电脑 ? "允许这台电脑加入团队同步？" : "允许这台手机查看和记录客户？"}</b><span /></div>
      <div className="m-me-card">
        <span className="m-avatar" style={{ width: 44, height: 44, background: "var(--brand-bg)", color: "var(--brand-deep)", fontSize: 20 }}>{x.电脑 ? <LaptopOutlined /> : <MobileOutlined />}</span>
        <div><b>{x.label}</b><span>用你的账号登录的{x.电脑 ? "另一台电脑" : "另一台手机"}</span></div>
      </div>
      <p className="m-note" style={{ padding: "0 4px" }}>
        {x.电脑
          ? "允许后，那台电脑拿到团队钥匙，和你的其它设备一样同步你能看到的客户、跟进、商机。我们的服务器只负责转交，看不到内容。"
          : "会把你能看到的客户、联系人、商机阶段和跟进，加密后传到那台手机。我们的服务器只负责转交，看不到内容。"}
        随时可以在电脑上「设置 → 团队 → 我的设备」里移除。
      </p>
      <div className="m-pair" style={{ marginTop: 16 }}>
        <span>{x.电脑 ? "那台电脑屏幕上的配对数字应该是" : "那台手机屏幕上的配对数字应该是"}</span>
        <b data-testid="m-approve-code">{x.配对数字.slice(0, 3)} {x.配对数字.slice(3)}</b>
        <small>对不上、或者不是你自己在用的设备，就点「不允许」</small>
      </div>
      <div className="m-unsynced-btns" style={{ marginTop: 16 }}>
        <button className="m-btn m-btn-ghost" disabled={忙 !== null} onClick={() => void 做("拒绝")}>{忙 === "拒绝" ? <span className="m-spinner is-on" /> : "不允许"}</button>
        <button className="m-btn" disabled={忙 !== null} onClick={() => void 做("允许")}>{忙 === "允许" ? <span className="m-spinner is-on is-light" /> : "允许"}</button>
      </div>
      <button className="m-text-btn" style={{ display: "block", margin: "12px auto 0" }} disabled={忙 !== null} onClick={onLater}>稍后再说</button>
    </div>
  );
}

/* ====================================================================== 登录 → 授权 → 首次同步 */

const 进场 = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -12 }, transition: { duration: 现状动效.时长.morph } };

function LoginFlow({ 失效提示, 遗留, onDone }: { 失效提示: string | null; 遗留: number; onDone: (token: string, 号: 账号) => Promise<void> }) {
  const [邮箱, set邮箱] = useState("");
  const [密码, set密码] = useState("");
  const [忙, set忙] = useState(false);
  const [错, set错] = useState<string | null>(null);
  async function 登录() {
    if (!邮箱.trim() || !密码 || 忙) return;
    set忙(true); set错(null);
    try {
      const r = await fetch("/api/account/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: 邮箱.trim(), password: 密码, name: `手机 · ${设备标签()}` }) });
      const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string; account?: { name?: string; contact?: string } };
      if (!r.ok || !j.token) { set错(j.error ?? "登录没成功，稍后再试"); return; }
      await onDone(j.token, { name: j.account?.name ?? "", contact: j.account?.contact ?? 邮箱.trim() });
    } catch {
      set错("连不上网络");
    } finally {
      set忙(false);
    }
  }
  return (
    <motion.div className="m-flow" {...进场}>
      <div className="m-flow-top">
        {/* eslint-disable-next-line @next/next/no-img-element -- 小图标，不走图片优化 */}
        <img className="m-logo" src="/icon.svg" alt="" />
        <h1>Daedalus CRM</h1>
        <p>用桌面端的账号登录</p>
      </div>
      {失效提示 && <div className="m-callout" style={{ margin: "20px 0 0" }}>{失效提示}</div>}
      {遗留 > 0 && <div className="m-callout" style={{ margin: "12px 0 0" }}>有 {遗留} 条之前没同步上的跟进还留着，重新连上后在「今天」页顶上能找到。</div>}
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); void 登录(); }}>
        <label><span>手机号或邮箱</span><input type="text" inputMode="email" autoComplete="username" autoCapitalize="none" value={邮箱} onChange={(e) => set邮箱(e.target.value)} placeholder="name@company.com" /></label>
        <label><span>密码</span><input type="password" autoComplete="current-password" value={密码} onChange={(e) => set密码(e.target.value)} /></label>
        {错 && <div className="m-form-err">{错}</div>}
        <button className="m-btn m-btn-block" disabled={!邮箱.trim() || !密码 || 忙}>{忙 ? <span className="m-spinner is-on is-light" /> : "登录"}</button>
      </form>
      <div className="m-flow-foot">
        <p>团队版成员可用。还没有账号？先在电脑上装桌面端注册。</p>
        <p className="m-faint">登录后一直保持，除非在电脑上移除这台手机或改了密码</p>
      </div>
    </motion.div>
  );
}

/**
 * 这台手机的设备号和钥匙对：第一次用时生成、存进本地库，之后一直用这一对（配对数字跟着它）。
 * 同一时刻只生成一次：页面重开、效果跑两遍时不会各生成一对、各发一条申请（电脑上就会多出一条对不上数字的）
 */
let 生成中: Promise<设备> | null = null;
function 本机设备(库: 本地库): Promise<设备> {
  生成中 ??= (async () => {
    const 有 = (await 库.读("dev")) as 设备 | undefined;
    if (有) return 有;
    // 可导出：本地库要把它封起来再存（Safari 存不住 X25519 的 CryptoKey，见 store.ts）
    const k = await 密.设备钥匙对(true);
    const d = { device: 连.新设备号(), 公钥: k.公钥, 私钥: k.私钥 };
    await 库.写("dev", d);
    return d;
  })().finally(() => { 生成中 = null; });
  return 生成中;
}

function AuthorizeFlow({ token, 库, onApproved, onRestart }: { token: string; 库: 本地库; onApproved: (团: 同步.手机团队, 名: string) => Promise<void>; onRestart: () => Promise<void> }) {
  const [数字, set数字] = useState<string | null>(null);
  const [状态, set状态] = useState<"pending" | "denied" | "expired" | "error">("pending");
  const [错, set错] = useState<string | null>(null);
  // 个人版账号 / 团队没开 / 电脑还没连上团队：不生成配对数字、不发申请，直接说清楚（2026-10-19 客户反馈手机一直干等）
  const [不能, set不能] = useState<"no-team" | "inactive" | "no-device" | null>(null);
  const [再查, set再查] = useState(0);
  const 设 = useRef<设备 | null>(null);
  // 外层每 30 秒重画一次（「现在」走表），onApproved 每次都是新函数：放进 ref，别让它把申请流程整个重跑一遍
  const 批了 = useRef(onApproved);
  useEffect(() => { 批了.current = onApproved; });
  useEffect(() => {
    let 停 = false;
    const 云 = 做传输(token, () => undefined);
    (async () => {
      const 资 = await 连.查资格(云);
      if (停) return;
      if (资 !== "ok") { set不能(资); return; }
      set不能(null);
      const d = await 本机设备(库);
      设.current = d;
      await 连.发申请(云, { device: d.device, pubKey: d.公钥, label: 设备标签() }).catch((e: unknown) => {
        const 拦 = 连.资格被拦(e instanceof Error ? e.message : String(e));
        if (拦) { 停 = true; set不能(拦); }
        throw e;
      });
      const n = await 密.配对数字(d.公钥);
      if (!停) set数字(n);
      while (!停) {
        const r = await 连.查申请(云, { device: d.device, 私钥: d.私钥 }).catch((e: unknown) => { const 话 = e instanceof Error ? e.message : String(e); if (/登录已失效/.test(话)) throw e; return null; });
        if (停) return;
        if (r?.status === "approved") { await 批了.current(r.团队, r.teamName); return; }
        if (r && (r.status === "denied" || r.status === "expired" || r.status === "removed")) { set状态(r.status === "denied" ? "denied" : "expired"); return; }
        await new Promise((ok) => setTimeout(ok, 3000));
      }
    })().catch((e: unknown) => { if (!停) { set状态("error"); set错(e instanceof Error ? e.message : String(e)); } });
    return () => { 停 = true; };
  }, [token, 库, 再查]);

  if (不能) return <NotTeamScreen why={不能} onRetry={() => set再查((n) => n + 1)} onLogout={onRestart} />;

  return (
    <motion.div className="m-flow" {...进场}>
      <div className="m-flow-top">
        <h1>请在你的电脑或手机上授权</h1>
        <p>打开你已经连上的电脑（Daedalus CRM）或手机（这个手机版），会弹出一个框，核对下面的数字后点「允许」</p>
      </div>
      <div className="m-pair">
        <span>配对数字</span>
        <b>{数字 ? `${数字.slice(0, 3)} ${数字.slice(3)}` : "··· ···"}</b>
        <small>和那台设备上显示的一样才点允许</small>
      </div>
      {状态 === "pending" && <div className="m-waiting"><span /><span /><span />等那边点允许</div>}
      {状态 === "denied" && <div className="m-callout">那边点了「不允许」。如果是误点，重新登录再来一次。</div>}
      {状态 === "expired" && <div className="m-callout">这次申请过期了，重新登录再来一次。</div>}
      {状态 === "error" && <div className="m-callout">{错}</div>}
      <div className="m-flow-foot">
        <p className="m-faint">电脑不在身边？先放着，打开桌面端或已连上的手机版就会弹出来。只有第一次需要授权。</p>
        {状态 !== "pending" && <button className="m-btn m-btn-block" onClick={() => void onRestart()}>重新登录</button>}
        {状态 === "pending" && <button className="m-text-btn" onClick={() => void onRestart()}>换个账号</button>}
      </div>
    </motion.div>
  );
}

/** 连不了手机的三种情况（2026-10-19）：不生成配对数字，说清楚为什么、下一步做什么 */
function NotTeamScreen({ why, onRetry, onLogout }: { why: "no-team" | "inactive" | "no-device"; onRetry: () => void; onLogout: () => Promise<void> }) {
  const 话 = {
    "no-team": { 标题: "手机伴侣是团队版功能", 正文: "个人版的数据只在你的电脑上，手机连不上。想用手机记跟进，可以私信我们开通团队版。" },
    inactive: { 标题: "团队同步还没开通", 正文: "你在团队里，但团队同步还没开通或已经停用。开通后再回来连手机；要开通可以私信我们。" },
    "no-device": { 标题: "先在电脑上连上团队", 正文: "先在电脑上连上团队，再回来连手机。打开电脑上的 Daedalus CRM，在「设置 → 团队」里用邀请码加入；连上后回到这里点「再试一次」。" },
  }[why];
  return (
    <motion.div className="m-flow" {...进场} data-testid="m-not-team" data-why={why}>
      <div className="m-flow-top">
        <h1>{话.标题}</h1>
        <p>{话.正文}</p>
      </div>
      <div className="m-flow-foot">
        {why !== "no-team" && <button className="m-btn m-btn-block" onClick={onRetry}>再试一次</button>}
        <button className={why === "no-team" ? "m-btn m-btn-block" : "m-text-btn"} onClick={() => void onLogout()}>退出登录</button>
      </div>
    </motion.div>
  );
}

function FirstSync({ 团队, 云, 库, 取状态, onDone, onFail }: { 团队: 同步.手机团队; 云: 同步.传输; 库: 本地库; 取状态: () => 同步.同步状态; onDone: (c: 同步.手机团队) => Promise<void>; onFail: (话: string) => void }) {
  const [错, set错] = useState<string | null>(null);
  const [次, set次] = useState(0);
  const [数, set数] = useState({ 客户: 0, 跟进: 0 });
  // 同 AuthorizeFlow：回调放 ref，外层 30 秒重画不会再开一轮同步、和没跑完的那轮叠在一起
  const 回 = useRef({ onDone, onFail });
  useEffect(() => { 回.current = { onDone, onFail }; });
  useEffect(() => {
    let 停 = false;
    const 数一数 = () => { const 键 = [...库.行.keys()]; set数({ 客户: 键.filter((k) => k.startsWith("Customer:")).length, 跟进: 键.filter((k) => k.startsWith("FollowUp:")).length }); };
    const t = setInterval(数一数, 300);
    同步.同步一轮(团队, 云, 库, 取状态())
      .then(async (r) => { 数一数(); if (!停) await 回.current.onDone(r.c); })
      .catch((e: unknown) => { const 话 = e instanceof Error ? e.message : String(e); if (!停) { set错(话); 回.current.onFail(话); } })
      .finally(() => clearInterval(t));
    return () => { 停 = true; clearInterval(t); };
  }, [团队, 云, 库, 取状态, 次]);
  return (
    <motion.div className="m-flow m-flow-center" {...进场}>
      {!错 && <span className="m-spinner is-on m-spinner-big" />}
      <h1>{错 ? 首次同步失败(错).标题 : "正在从团队同步"}</h1>
      <div className="m-sync-counts">
        <div><b>{数.客户}</b><span>位客户</span></div>
        <div><b>{数.跟进}</b><span>条跟进</span></div>
      </div>
      {错 ? (
        <>
          <p className="m-faint" data-testid="m-first-sync-why">{首次同步失败(错).话}</p>
          <button className="m-btn" onClick={() => { set错(null); set次((n) => n + 1); }}>再试一次</button>
        </>
      ) : <p className="m-faint"><LockOutlined /> 加密传输 · 服务器看不到内容</p>}
    </motion.div>
  );
}
