"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue } from "motion/react";
import {
  AudioOutlined, CalendarFilled, CalendarOutlined, CheckCircleFilled, CloseCircleFilled, CloseOutlined, CloudSyncOutlined, CopyOutlined,
  DisconnectOutlined, EditOutlined, ExclamationCircleFilled, LaptopOutlined, LockOutlined, MailOutlined, PhoneOutlined, RightOutlined,
  SearchOutlined, WhatsAppOutlined,
} from "@ant-design/icons";
import * as 同步 from "@/lib/mobile/sync";
import * as 连 from "@/lib/mobile/link";
import * as 密 from "@/lib/sync/crypto-web";
import { 本地库, 申请长期保存 } from "@/lib/mobile/store";
import { 分表, 客户们 as 算客户们, 今天要跟, 搜, 国旗, 简称, 相对时间, 金额, type 客户视图 } from "@/lib/mobile/view";
import { Avatar, BaseLayer, InstallHint, Page, Sheet, StatusTag, SyncChip, TabBar, TopLayer, 已装到主屏幕, 弹簧, 猜系统, 震一下, type 标签, type 系统 } from "./ui";
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
type 面板 = null | { kind: "record"; id: string } | { kind: "me" } | { kind: "unsynced" };
type 深浅 = "auto" | "light" | "dark";
type 设备 = { device: string; 公钥: string; 私钥: CryptoKey };
type 账号 = { name: string; contact: string };
type 遗留 = { content: string; customer: string; at: number };
/** 同步状态会被同步库原地改，放在 ref 里只在回调中动；渲染读这一份快照（改完一次拍一次） */
type 快照 = { 待推跟进: string[]; 被拒: { content: string; customerId: string; at: number; 原因: string }[]; lastSyncAt: number | null; lastError: string | null };
const 拍 = (s: 同步.同步状态): 快照 => ({
  待推跟进: s.待推.filter((e) => e.t === "FollowUp").map((e) => e.k),
  被拒: s.被拒.filter((x) => x.改动.t === "FollowUp" && x.改动.r).map((x) => ({ content: String(x.改动.r!.content ?? ""), customerId: String(x.改动.r!.customerId ?? ""), at: Number(x.改动.r!.occurredAt) || 0, 原因: x.原因 })),
  lastSyncAt: s.lastSyncAt ? Date.parse(s.lastSyncAt) : null,
  lastError: s.lastError ?? null,
});

const 订尺寸 = (cb: () => void) => { window.addEventListener("resize", cb); return () => window.removeEventListener("resize", cb); };
const 不订 = () => () => {};
const 类型表 = [
  { value: "PHONE", 短: "电话", color: "var(--cat-green)", label: "电话沟通" },
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
  const 器 = /EdgA|EdgiOS/.test(ua) ? "Edge" : /CriOS|Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "浏览器";
  return `${机} · ${器}`.slice(0, 60);
}

/** 和云端说话：同源接口 + 手机自己的令牌。断网回 状态 0 */
function 做传输(token: string, 记断网: (断: boolean) => void): 同步.传输 {
  return async (方法, 路径, body) => {
    try {
      const r = await fetch(路径, {
        method: 方法, cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
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
  const [团队, set团队] = useState<同步.手机团队 | null>(null);
  const [团队名, set团队名] = useState("");
  const [账号, set账号] = useState<账号 | null>(null);
  const 态 = useRef<同步.同步状态>(同步.新状态());
  const [快照, set快照] = useState<快照>(() => 拍(同步.新状态()));
  const 拍一下 = useCallback(() => set快照(拍(态.current)), []);
  const 取状态 = useCallback(() => 态.current, []);
  const [版本, set版本] = useState(0);
  const [在同步, set在同步] = useState(false);
  const [断网, set断网] = useState(false);
  const [提示, set提示] = useState<{ id: number; 字: string; 图?: ReactNode } | null>(null);
  const [失效提示, set失效提示] = useState<string | null>(null);
  const [遗留们, set遗留们] = useState<遗留[]>([]);
  const [深色, set深色] = useState<深浅>("auto");
  const [tab, setTab] = useState<标签>("today");
  const [详情, set详情] = useState<string | null>(null);
  const [面板, set面板] = useState<面板>(null);
  const [现在, set现在] = useState(() => Date.now());
  const 同步中 = useRef(false);

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
      const [t, 团, 态0, 名, 号, 遗, 深] = await Promise.all([k.读("token"), k.读("team"), k.读("state"), k.读("teamName"), k.读("account"), k.读("leftover"), k.读("dark")]);
      if (停) return;
      if (态0) { 态.current = 态0 as 同步.同步状态; set快照(拍(态.current)); }
      set遗留们((遗 as 遗留[] | undefined) ?? []);
      set深色((深 as 深浅 | undefined) ?? "auto");
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
    const 没推的 = [...态.current.待推, ...态.current.被拒.map((x) => x.改动)].filter((e) => e.t === "FollowUp" && e.r);
    const 名们 = new Map((await k.键们()).filter((x) => x.startsWith("Customer:")).map((x) => [x.slice(9), ""]));
    for (const id of 名们.keys()) 名们.set(id, String((await k.取("Customer", id))?.r.name ?? ""));
    const 留 = [...遗留们, ...没推的.map((e) => ({ content: String(e.r!.content ?? ""), customer: 名们.get(String(e.r!.customerId)) ?? "", at: Number(e.r!.occurredAt) || Date.now() }))];
    await k.清空();
    await k.写("leftover", 留);
    态.current = 同步.新状态(); 拍一下();
    set遗留们(留); set团队(null); setToken(null); set详情(null); set面板(null); set团队名("");
    set失效提示(话);
    set阶段("login");
  }, [遗留们, 库, 拍一下]);

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
      if (/登录已失效/.test(话)) { await 失效("这台手机的登录失效了：在电脑上移除了这台手机，或者改过密码。为了安全，手机上的客户数据已经清掉，重新登录后在电脑上授权就行。"); return; }
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

  /* ---------- 返回：一律走浏览器历史（安卓返回键 / 手势和页面上的返回按钮同一条路） ---------- */
  const 顶x = useMotionValue(0);
  const 层 = useRef({ 详情: null as string | null, 面板: null as 面板 });
  useEffect(() => { 层.current = { 详情, 面板 }; });
  const 收详情 = useCallback(() => { animate(顶x, 宽, { ...弹簧, stiffness: 380 }).then(() => { set详情(null); 顶x.set(0); }); }, [顶x, 宽]);
  useEffect(() => {
    const on = () => { if (层.current.面板) set面板(null); else if (层.current.详情) 收详情(); };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, [收详情]);
  const 打开详情 = (id: string) => { history.pushState({ m: "detail" }, ""); set详情(id); 顶x.set(os === "ios" ? 宽 : 宽 * 0.18); animate(顶x, 0, 弹簧); };
  const 打开面板 = (p: NonNullable<面板>) => { history.pushState({ m: "sheet" }, ""); set面板(p); };
  const 返回 = () => history.back();

  /* ---------- 数据 ---------- */
  const 我 = 团队?.userId ?? "";
  const 客户们 = useMemo(() => {
    void 版本;
    const k = 库;
    if (!k || !团队) return [] as 客户视图[];
    return 算客户们(分表(k.行.values()), 团队.userId, new Set(快照.待推跟进));
  }, [版本, 团队, 库, 快照]);
  const 待同步数 = 快照.待推跟进.length;
  const 没同步上 = useMemo(() => {
    const 名 = new Map(客户们.map((c) => [c.id, c.name]));
    return [
      ...快照.被拒.map((x, i) => ({ key: `r${i}`, 来自: "被拒" as const, i, content: x.content, customer: 名.get(x.customerId) ?? "", at: x.at, 原因: x.原因 })),
      ...遗留们.map((x, i) => ({ key: `l${i}`, 来自: "遗留" as const, i, ...x, 原因: "登录失效前没同步上" })),
    ];
  }, [客户们, 遗留们, 快照]);
  const 当前客户 = 客户们.find((c) => c.id === 详情) ?? null;

  async function 记(id: string, 输入: Omit<同步.记跟进输入, "customerId">) {
    const k = 库;
    if (!k || !团队) return;
    try {
      await 同步.记跟进(团队, k, 态.current, { customerId: id, ...输入 });
      await k.存盘();
      await k.写("state", 态.current);
      拍一下();
      set版本((v) => v + 1);
      震一下();
      说(断网 ? "已记下 · 有网后自动同步" : "已记下", 断网 ? <CloudSyncOutlined /> : <CheckCircleFilled />);
      void 跑同步();
    } catch (e) {
      说(e instanceof Error ? e.message : String(e), <ExclamationCircleFilled />);
    }
  }

  async function 处理掉(x: { 来自: "被拒" | "遗留"; i: number }) {
    const k = 库;
    if (!k) return;
    if (x.来自 === "被拒") {
      const 剩 = 态.current.被拒.filter((r) => r.改动.t === "FollowUp" && r.改动.r);
      const 去 = 剩[x.i];
      态.current.被拒 = 态.current.被拒.filter((r) => r !== 去);
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
    set团队(null); setToken(null); set账号(null); set遗留们([]); set面板(null); set详情(null); set失效提示(null);
    set阶段("login");
  }

  const 根属性 = { "data-os": os, "data-dark": 深色 } as Record<string, string>;
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
            onRestart={async () => { await 库?.写("token", undefined); setToken(null); set阶段("login"); }} />
        )}
        {阶段 === "syncing" && 团队 && 云 && (
          <FirstSync key="sync" 团队={团队} 云={云} 库={库!} 取状态={取状态}
            onDone={async (c) => {
              const k = 库!;
              set团队(c); await k.写("team", c); await k.存盘(); await k.写("state", 态.current); 拍一下();
              set版本((v) => v + 1);
              set阶段("app");
            }}
            onFail={(话) => { if (/登录已失效/.test(话)) void 失效("登录失效了，请重新登录"); }} />
        )}
        {阶段 === "app" && 团队 && (
          <motion.div key="app" className="m-app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
            <BaseLayer 顶x={顶x} 宽={宽} os={os} 有详情={!!详情}>
              <div className="m-tabs-body">
                {tab === "today"
                  ? <TodayScreen os={os} 今天={今天} 现在={现在} 断网={断网} 待同步={待同步数} 上次同步={快照.lastSyncAt} 在同步={在同步}
                      没同步上={没同步上.length} 名={账号?.name ?? ""} onOpen={打开详情} onMe={() => 打开面板({ kind: "me" })} onUnsynced={() => 打开面板({ kind: "unsynced" })} onSync={() => 跑同步(true)} />
                  : <CustomersScreen os={os} 客户们={客户们} 我={我} 现在={现在} 断网={断网} 名={账号?.name ?? ""} onOpen={打开详情} onMe={() => 打开面板({ kind: "me" })} onSync={() => 跑同步(true)} />}
              </div>
              <TabBar os={os} tab={tab} onTab={(t) => { if (t !== tab) { setTab(t); 震一下(); } }} 今天数={今天数} />
            </BaseLayer>
            {当前客户 && (
              <TopLayer 顶x={顶x} 宽={宽} os={os} onBack={返回}>
                <DetailScreen os={os} c={当前客户} 现在={现在} 来自={tab === "today" ? "今天" : "客户"} onBack={返回} onRecord={() => 打开面板({ kind: "record", id: 当前客户.id })} />
              </TopLayer>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {面板 && (
          <Sheet key={面板.kind} onClose={返回} 高={面板.kind === "record" ? "auto" : "tall"}>
            {面板.kind === "record" && (() => {
              const c = 客户们.find((x) => x.id === 面板.id);
              if (!c) return null;
              return <RecordSheet c={c} os={os} 我={我} onCancel={返回} onSave={(输入) => { void 记(c.id, 输入); 返回(); }} />;
            })()}
            {面板.kind === "me" && (
              <MeSheet 账号={账号} 团队名={团队名} 断网={断网} 待同步={待同步数} 在同步={在同步} 上次同步={快照.lastSyncAt}
                错误={快照.lastError} 现在={现在} 深色={深色} 没同步上={没同步上.length}
                set深色={(d) => { set深色(d); void 库?.写("dark", d); }}
                onSync={() => void 跑同步(true)} onUnsynced={() => { 返回(); setTimeout(() => 打开面板({ kind: "unsynced" }), 300); }}
                onLogout={() => { 返回(); setTimeout(() => void 退出(), 250); }} />
            )}
            {面板.kind === "unsynced" && <UnsyncedSheet 列={没同步上} 说={说} on处理={(x) => void 处理掉(x)} />}
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

function TodayScreen({ os, 今天, 现在, 断网, 待同步, 上次同步, 在同步, 没同步上, 名, onOpen, onMe, onUnsynced, onSync }: {
  os: 系统; 今天: ReturnType<typeof 今天要跟>; 现在: number; 断网: boolean; 待同步: number; 上次同步: number | null; 在同步: boolean;
  没同步上: number; 名: string; onOpen: (id: string) => void; onMe: () => void; onUnsynced: () => void; onSync: () => Promise<void>;
}) {
  const d = new Date(现在);
  const 已装 = useSyncExternalStore(不订, 已装到主屏幕, () => true);
  const [关了装提示, set关了装提示] = useState(false);
  return (
    <Page os={os} 标题="今天" 右={<button className="m-me" onClick={onMe} aria-label="我的">{简称(名 || "我")}</button>}
      副标题={<><span>{d.getMonth() + 1}月{d.getDate()}日 周{"日一二三四五六"[d.getDay()]}</span><SyncChip 断网={断网} 待同步={待同步} 上次同步={上次同步} 现在={现在} 在同步={在同步} /></>}
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

function CustomersScreen({ os, 客户们, 我, 现在, 断网, 名, onOpen, onMe, onSync }: { os: 系统; 客户们: 客户视图[]; 我: string; 现在: number; 断网: boolean; 名: string; onOpen: (id: string) => void; onMe: () => void; onSync: () => Promise<void> }) {
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
  return (
    <Page os={os} 标题="客户" 右={<button className="m-me" onClick={onMe} aria-label="我的">{简称(名 || "我")}</button>} onRefresh={onSync}
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
        </div>
      }>
      {断网 && <div className="m-offline-note"><DisconnectOutlined /> 离线：看到的是上次同步的内容</div>}
      {q && <div className="m-group-h m-group-h-solo">找到 {列表.length} 位</div>}
      {列表.length === 0 ? (
        <div className="m-empty m-empty-big">{q ? <>没有找到「{q}」<br /><small>手机上只搜得到你能看的客户</small></> : 段 === "pool" ? "公海里没有客户" : "还没有客户：在电脑上建好，这里会同步过来"}</div>
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
function DetailScreen({ os, c, 现在, 来自, onBack, onRecord }: { os: 系统; c: 客户视图; 现在: number; 来自: string; onBack: () => void; onRecord: () => void }) {
  const 主 = c.联系人[0];
  const 电话 = 主?.phone || c.phone;
  const 邮箱 = 主?.email || c.email;
  const 阶 = c.商机 ? 阶段表.indexOf(c.商机.stage) : -1;
  const 今早 = new Date(现在); 今早.setHours(0, 0, 0, 0);
  const 过期 = c.计划 && c.计划.at < 今早.getTime();
  return (
    <Page os={os} 标题={c.name} 返回={onBack} 返回字={来自}
      底部={c.公海 ? null : <div className="m-bottom-bar"><button className="m-btn m-btn-block" onClick={onRecord}><EditOutlined /> 记一笔跟进</button></div>}>
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
        {c.公海 ? <a className="is-off"><span><EditOutlined /></span>记一笔</a> : <button onClick={onRecord} className="is-brand"><span><EditOutlined /></span>记一笔</button>}
      </div>

      {c.公海 && <div className="m-callout">公海客户：在电脑上领取后归你跟进，才能在这里记跟进。</div>}

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

      {c.商机 && (
        <section className="m-card">
          <div className="m-card-h">商机<span className="m-amount">{金额(c.商机.amount, c.商机.currency)}</span></div>
          <div className="m-opp-name">{c.商机.name}</div>
          {阶 >= 0 && (
            <>
              <div className="m-stages">{阶段表.map((s, i) => <i key={s} className={i <= 阶 ? "is-on" : ""} />)}</div>
              <div className="m-stage-l"><b>{c.商机.stage}</b><span>第 {阶 + 1} / {阶段表.length} 步</span></div>
            </>
          )}
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
      <div className="m-foot-note">改资料、建商机、领取公海客户请在电脑上操作</div>
    </Page>
  );
}

/* ====================================================================== 记一笔 */

function 计划标题(字: string) {
  const 首句 = 字.trim().split(/[，。！？,.!?\n]/)[0].slice(0, 20);
  return 首句 ? `接着跟进：${首句}` : "接着跟进";
}

function RecordSheet({ c, os, 我, onCancel, onSave }: { c: 客户视图; os: 系统; 我: string; onCancel: () => void; onSave: (x: Omit<同步.记跟进输入, "customerId">) => void }) {
  const [t, setT] = useState<(typeof 同步.手机跟进类型)[number]>("SMS");
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
    onSave({ type: t, content: 内容, 下次: 时间 ? { 时间, 主题: 计划标题(内容), 方式: 类型(t).label } : null, 完成计划: 我的计划 && 完成 ? 我的计划.id : null });
  };
  const 可存 = 字.trim().length > 0;

  return (
    <div className="m-record">
      <div className="m-sheet-h">
        <button className="m-text-btn" onClick={onCancel}>{os === "ios" ? "取消" : <CloseOutlined />}</button>
        <b>记一笔跟进</b>
        <button className="m-text-btn is-strong" disabled={!可存} onClick={存}>保存</button>
      </div>
      <div className="m-record-who"><Avatar name={c.name} size={28} /><span className="m-ellipsis">{c.name}</span><span className="m-flag">{国旗(c.country)}</span></div>
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

/* ====================================================================== 我的、没同步上的 */

function MeSheet({ 账号, 团队名, 断网, 待同步, 在同步, 上次同步, 错误, 现在, 深色, set深色, 没同步上, onSync, onUnsynced, onLogout }: {
  账号: 账号 | null; 团队名: string; 断网: boolean; 待同步: number; 在同步: boolean; 上次同步: number | null; 错误: string | null; 现在: number;
  深色: 深浅; set深色: (d: 深浅) => void; 没同步上: number; onSync: () => void; onUnsynced: () => void; onLogout: () => void;
}) {
  const [确认退出, set确认退出] = useState(false);
  return (
    <div className="m-me-sheet">
      <div className="m-me-card">
        <span className="m-avatar" style={{ width: 52, height: 52, background: "var(--brand-bg)", color: "var(--brand-deep)", fontSize: 19 }}>{简称(账号?.name || "我")}</span>
        <div><b>{账号?.name || "我"}</b>{账号?.contact && <span>{账号.contact}</span>}{团队名 && <span>{团队名}</span>}</div>
      </div>
      <div className="m-list m-list-inset">
        <div className="m-kv"><CloudSyncOutlined /><span>同步</span><b><SyncChip 断网={断网} 待同步={待同步} 上次同步={上次同步} 现在={现在} 在同步={在同步} /></b></div>
        <div className="m-kv"><LockOutlined /><span>加密</span><b>端到端，服务器看不到内容</b></div>
        {错误 && <div className="m-kv m-kv-col"><span className="is-danger">{错误}</span></div>}
        <button className="m-kv m-kv-btn" onClick={onSync} disabled={在同步}>立即同步</button>
        {没同步上 > 0 && <button className="m-kv m-kv-btn" onClick={onUnsynced}>没同步上的跟进（{没同步上}）</button>}
      </div>
      <div className="m-list m-list-inset">
        <div className="m-kv m-kv-col"><span>深浅色</span>
          <div className="m-seg m-seg-sm m-seg-3">
            {(["auto", "light", "dark"] as const).map((k) => <button key={k} className={深色 === k ? "is-on" : ""} onClick={() => set深色(k)}>{{ auto: "跟随系统", light: "浅色", dark: "深色" }[k]}</button>)}
            <i className="m-seg-thumb" style={{ transform: `translateX(${["auto", "light", "dark"].indexOf(深色) * 100}%)` }} />
          </div>
        </div>
      </div>
      <div className="m-list m-list-inset">
        {!确认退出 ? (
          <button className="m-kv m-kv-btn is-danger" onClick={() => set确认退出(true)}>退出登录</button>
        ) : (
          <>
            <div className="m-kv m-kv-col"><span>退出后手机上的客户数据会清掉{待同步 ? `，还有 ${待同步} 条没同步上的跟进也会丢` : ""}。下次登录要在电脑上重新授权。</span></div>
            <button className="m-kv m-kv-btn is-danger" onClick={onLogout}>确认退出</button>
            <button className="m-kv m-kv-btn" onClick={() => set确认退出(false)}>算了</button>
          </>
        )}
      </div>
      <div className="m-foot-note">在电脑上「设置 → 团队 → 手机」里可以随时移除这台手机</div>
    </div>
  );
}

function UnsyncedSheet({ 列, 说, on处理 }: { 列: { key: string; 来自: "被拒" | "遗留"; i: number; content: string; customer: string; at: number; 原因: string }[]; 说: (s: string, 图?: ReactNode) => void; on处理: (x: { 来自: "被拒" | "遗留"; i: number }) => void }) {
  return (
    <div className="m-me-sheet">
      <div className="m-sheet-h"><span /><b>没同步上的跟进</b><span /></div>
      <p className="m-note" style={{ padding: "0 4px 12px" }}>这些跟进没进任何人的电脑（客户转给了别人，或者登录失效前没来得及传）。复制下来，在对的客户上重新记一笔。</p>
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

/* ====================================================================== 登录 → 授权 → 首次同步 */

const 进场 = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -12 }, transition: { duration: 0.28 } };

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

function AuthorizeFlow({ token, 库, onApproved, onRestart }: { token: string; 库: 本地库; onApproved: (团: 同步.手机团队, 名: string) => Promise<void>; onRestart: () => Promise<void> }) {
  const [数字, set数字] = useState<string | null>(null);
  const [状态, set状态] = useState<"pending" | "denied" | "expired" | "error">("pending");
  const [错, set错] = useState<string | null>(null);
  const 设 = useRef<设备 | null>(null);
  useEffect(() => {
    let 停 = false;
    const 云 = 做传输(token, () => undefined);
    (async () => {
      let d = (await 库.读("dev")) as 设备 | undefined;
      if (!d) { const k = await 密.设备钥匙对(); d = { device: 连.新设备号(), 公钥: k.公钥, 私钥: k.私钥 }; await 库.写("dev", d); }
      设.current = d;
      await 连.发申请(云, { device: d.device, pubKey: d.公钥, label: 设备标签() });
      const n = await 密.配对数字(d.公钥);
      if (!停) set数字(n);
      while (!停) {
        const r = await 连.查申请(云, { device: d.device, 私钥: d.私钥 }).catch((e: unknown) => { const 话 = e instanceof Error ? e.message : String(e); if (/登录已失效/.test(话)) throw e; return null; });
        if (停) return;
        if (r?.status === "approved") { await onApproved(r.团队, r.teamName); return; }
        if (r && (r.status === "denied" || r.status === "expired" || r.status === "removed")) { set状态(r.status === "denied" ? "denied" : "expired"); return; }
        await new Promise((ok) => setTimeout(ok, 3000));
      }
    })().catch((e: unknown) => { if (!停) { set状态("error"); set错(e instanceof Error ? e.message : String(e)); } });
    return () => { 停 = true; };
  }, [token, 库, onApproved]);

  return (
    <motion.div className="m-flow" {...进场}>
      <div className="m-flow-top">
        <h1>请在你的电脑上授权</h1>
        <p>打开电脑上的 Daedalus CRM，会弹出一个框，核对下面的数字后点「允许」</p>
      </div>
      <div className="m-pair">
        <span>配对数字</span>
        <b>{数字 ? `${数字.slice(0, 3)} ${数字.slice(3)}` : "··· ···"}</b>
        <small>和电脑上显示的一样才点允许</small>
      </div>
      {状态 === "pending" && <div className="m-waiting"><span /><span /><span />等电脑那边点允许</div>}
      {状态 === "denied" && <div className="m-callout">电脑那边点了「不允许」。如果是误点，重新登录再来一次。</div>}
      {状态 === "expired" && <div className="m-callout">这次申请过期了，重新登录再来一次。</div>}
      {状态 === "error" && <div className="m-callout">{错}</div>}
      <div className="m-flow-foot">
        <p className="m-faint">电脑不在身边？先放着，回到电脑前打开桌面端就会弹出来。只有第一次需要授权。</p>
        {状态 !== "pending" && <button className="m-btn m-btn-block" onClick={() => void onRestart()}>重新登录</button>}
        {状态 === "pending" && <button className="m-text-btn" onClick={() => void onRestart()}>换个账号</button>}
      </div>
    </motion.div>
  );
}

function FirstSync({ 团队, 云, 库, 取状态, onDone, onFail }: { 团队: 同步.手机团队; 云: 同步.传输; 库: 本地库; 取状态: () => 同步.同步状态; onDone: (c: 同步.手机团队) => Promise<void>; onFail: (话: string) => void }) {
  const [错, set错] = useState<string | null>(null);
  const [次, set次] = useState(0);
  const [数, set数] = useState({ 客户: 0, 跟进: 0 });
  useEffect(() => {
    let 停 = false;
    const 数一数 = () => { const 键 = [...库.行.keys()]; set数({ 客户: 键.filter((k) => k.startsWith("Customer:")).length, 跟进: 键.filter((k) => k.startsWith("FollowUp:")).length }); };
    const t = setInterval(数一数, 300);
    同步.同步一轮(团队, 云, 库, 取状态())
      .then(async (r) => { 数一数(); if (!停) await onDone(r.c); })
      .catch((e: unknown) => { const 话 = e instanceof Error ? e.message : String(e); if (!停) { set错(话); onFail(话); } })
      .finally(() => clearInterval(t));
    return () => { 停 = true; clearInterval(t); };
  }, [团队, 云, 库, 取状态, onDone, onFail, 次]);
  return (
    <motion.div className="m-flow m-flow-center" {...进场}>
      {!错 && <span className="m-spinner is-on m-spinner-big" />}
      <h1>{错 ? "没同步下来" : "正在从团队同步"}</h1>
      <div className="m-sync-counts">
        <div><b>{数.客户}</b><span>位客户</span></div>
        <div><b>{数.跟进}</b><span>条跟进</span></div>
      </div>
      {错 ? (
        <>
          <p className="m-faint">{错}</p>
          <button className="m-btn" onClick={() => { set错(null); set次((n) => n + 1); }}>再试一次</button>
        </>
      ) : <p className="m-faint"><LockOutlined /> 加密传输 · 服务器看不到内容</p>}
    </motion.div>
  );
}
