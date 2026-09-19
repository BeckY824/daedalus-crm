"use client";
/**
 * 全局 AI 面板。任何页面 ⌘J 拉出来，或者点右上角那枚常驻按钮。
 *
 * **形不是新发明的**：客户记录页早就是一个 `Drawer placement="right"`（380 宽），
 * 这里只是把它提到全局，并且把三种入口（首页整页 / 记录页常驻 + 抽屉 / 其余九页没有）
 * 收成一种。参考「Day844｜嵌入式 AI 对话界面动效」里右侧那一列 AI Inbox。
 *
 * 四条规矩：
 *   1. **导航稳定**——左栏一格不动。面板从右边推进来，正文收窄，不遮挡。
 *   2. **上下文看得见、点得掉**——顶上一行写明它带了什么，旁边一个 ×。
 *      一个隐形的上下文，答歪了没人解释得清为什么。
 *   3. 首页不出现它：首页本身就是宽模式的同一块东西，两处同时画会共用同一条对话、互相打架。
 *   4. 动效只用四档时长；减弱动态时不位移（globals.css 里 .dock 那几条）。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CloseOutlined, MessageOutlined } from "@ant-design/icons";
import WidthHandle, { 面板把手 } from "./WidthHandle";
import DockThreads from "./DockThreads";
import HomeChat, { type Suggestion } from "@/app/(app)/dashboard/HomeChat";
import type { ModelOption } from "@/lib/llm";
import { 认页面 } from "@/lib/ai-context-page";
import { 订阅页面行, 读页面行 } from "@/lib/page-rows";

/** 服务端快照。固定一个引用，useSyncExternalStore 才不会每次都当成变了 */
const 空名单: string[] = [];

/** 记录页那种「这一页说的是谁」——由页面自己登记，路径看不出人名 */
let 详情名: string | null = null;
export function 登记详情名(名: string | null) {
  详情名 = 名;
}

export default function AiDock({
  userName,
  models,
  aiQuota,
  开着,
  set开着,
}: {
  userName: string;
  models: ModelOption[];
  aiQuota?: { 上限: number; 还剩: number } | null;
  /**
   * 开合状态**由壳持有**，不在这儿。因为正文宽度跟着它变，壳要据此调响应式断点
   * （见 globals.css 的 .shell-dock-open）。放在这儿再用 effect 往上报的话，
   * 就成了「effect 里同步 setState」——级联渲染，eslint 直接报错。
   */
  开着: boolean;
  set开着: (开: boolean) => void;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  /**
   * 用户在**哪一页**把上下文点掉了。存页面而不是存布尔值：
   * 换一页就自动重新带上（那是新的一页，不是他刚才拒绝的那个），
   * 不需要一个「pathname 变了就 setState」的 effect。
   */
  const [不带上下文的页, set不带上下文的页] = useState<string | null>(null);
  const 不带上下文 = 不带上下文的页 === pathname;

  /*
    ⌘J / Ctrl+J 开关。在输入框里也认——它开的是另一块地方，不抢当前输入。

    **Esc 不关面板**（2026-09-19 用户要求，而且它本来就是个 bug）：
    面板是常驻的一栏，不是弹层——弹层按 Esc 关，一栏不该。
    更硬的理由是 Esc 在面板里**已经有主人**：答案正在流的时候它是「打断」
    （HomeChat 里那句 `Escape && running → cancelStream`，输入框下面也写着「Esc 打断」）。
    两个处理器听同一个键，于是想按 Esc 停下一个跑偏的回答，会连面板一起收掉——
    人失去的不只是那一栏，还有刚才那半截回答的上下文。
    要关有两条路：⌘J，或者面板右上角那个 ×。两条都是明确说「我要关它」。
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        set开着(!开着);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [开着]);

  // 这一页上列着的名字（DataList 登记的）。Hook 要在早退之前调，顺序每次一样
  const 可见行 = useSyncExternalStore(订阅页面行, 读页面行, () => 空名单);

  // 首页就是宽模式的它，不在那儿再开一块
  if (pathname === "/dashboard") return null;

  const 上下文 = 认页面(pathname, params, 详情名, 可见行);

  /*
    收起时是右边一条 44px 的窄边，不是浮在页面上的一枚圆钮。
    第一版做成 position:fixed 的药丸，实地一看**正好压在「新建客户」上**——
    每个列表页的主动作都在右上角，那正是它要去的位置。
    窄边是布局的一部分，正文跟着收窄，永远不会盖住任何东西；
    形也更接近参考里那条常驻的右列。
  */
  if (!开着) {
    return (
      <aside className="dock-rail">
        <button type="button" className="dock-rail-b" onClick={() => set开着(true)} aria-label="打开 AI 面板（⌘J）" title="问一句 · ⌘J">
          <MessageOutlined />
          <span className="dock-rail-k">⌘J</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="dock" aria-label="AI 面板">
      {/* 左边那条能拖的缝。和左栏同一个组件，只是往左拖才变宽——它贴着窗口右缘 */}
      <WidthHandle 规格={面板把手} />
      <div className="dock-h">
        <b>问一句</b>
        {/*
          新对话 / 历史。面板那一屏是纯内存的，重开应用就没了——而首页有中栏
          那条列表可以翻，面板没有：在这一页问过的话，换一次页就再也找不回来，
          尽管它一直好好地躺在库里。历史只列**在这一页**问过的（scope）。
        */}
        <DockThreads scope={pathname} />
        <button type="button" className="dock-x" onClick={() => set开着(false)} aria-label="关闭 AI 面板">
          <CloseOutlined />
        </button>
      </div>
      {/* 上下文条：它带了什么，写出来；不想带就点掉 */}
      {上下文 && !不带上下文 && (
        <div className="dock-ctx">
          <span className="dock-ctx-n">{上下文.标签}</span>
          <button type="button" className="dock-ctx-x" onClick={() => set不带上下文的页(pathname)} aria-label="不带这一页的上下文">
            <CloseOutlined />
          </button>
        </div>
      )}
      <div className="dock-body">
        <HomeChat
          模式="窄"
          上下文提示={上下文 && !不带上下文 ? 上下文.提示 : undefined}
          上下文范围={上下文 && !不带上下文 ? 上下文.范围 : undefined}
          /*
            **一页一屏，不是全局一份。** 2026-09-19 报上来的：在线索页问一句，
            换到客户页、回到首页，那一问那一答跟着到处走——因为这个组件在每一页
            都渲染同一个 HomeChat，而 home-thread 原来就一份 `let turns`。
            scope 给 pathname：各页各一屏，互不相干；落库仍走同一张表，
            所以首页那条列表照样看得到在哪一页问过什么。
          */
          scope={pathname}
          标题前缀={上下文?.名}
          会话={null}
          userName={userName}
          suggestions={[] as Suggestion[]}
          context=""
          models={models}
          aiQuota={aiQuota}
          空库={false}
        />
      </div>
    </aside>
  );
}
