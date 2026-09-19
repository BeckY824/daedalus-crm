"use client";

/**
 * 面板头上那两枚小按钮：新对话 / 历史。
 *
 * **为什么面板需要它们。** 全局面板的那一屏是纯内存的（lib/home-thread），
 * 重开应用就没了；而首页有中栏那条列表可以翻，面板没有——在线索页问过的话，
 * 换一次页或者重启一次就再也找不回来了，尽管它一直好好地躺在库里。
 *
 * **只列这一页问过的**（scope，见 migrations/006）。这是和首页那条列表的分工：
 * 首页列全部（在哪一页问的都看得到），这里只列「在这一页问的」——
 * 人点开它是想接上刚才在这一页的那件事，不是想翻另外十个页面的账。
 * 列 10 条，再往下走「在首页看全部」。
 *
 * 不做的：这里不改名、不删。那两件事在首页那条列表上有完整的界面（含确认弹窗），
 * 一个 380 宽的下拉里再摆一套只会是半套。
 */
import { useState } from "react";
import Link from "next/link";
import { App, Dropdown, Spin } from "antd";
import { PlusOutlined, HistoryOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";
import { 新起一屏, useConversationId } from "@/lib/home-thread";
import { 载入历史 } from "@/lib/thread-history";
import { 列对话, 读对话, type 对话概要 } from "@/app/(app)/dashboard/threads";
import { dayjs } from "@/lib/utils";

/** 下拉里列几条。再多就该去首页那条列表了 */
const 条数 = 10;

export default function DockThreads({ scope }: { scope: string }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<对话概要[] | null>(null);
  const [转, set转] = useState(false);
  /** 这一屏现在挂在哪条对话上：下拉里给它一个选中态，人才知道自己在哪 */
  const 当前 = useConversationId(scope);

  /**
   * 点开才去要数据。面板在每一页都渲染，开着就查一次的话，
   * 每次换页都白跑一趟——而多数时候人根本不会点这枚按钮。
   */
  async function 打开(开: boolean) {
    if (!开) return;
    set转(true);
    try {
      setRows(await 列对话({ scope, 条数 }));
    } catch {
      setRows([]);
      message.error("翻不出这一页的历史");
    } finally {
      set转(false);
    }
  }

  async function 载入(id: string) {
    if (id === 当前) return; // 已经是它了，别白闪一下
    const c = await 读对话(id);
    // 读不到 = 在首页那条列表里删掉了。刷新一下下拉，别让一条幽灵留在单子上
    if (!c) {
      message.error("这条对话已经不在了");
      setRows((v) => v?.filter((r) => r.id !== id) ?? null);
      return;
    }
    载入历史(scope, c);
  }

  const items: MenuProps["items"] = 转
    ? [{ key: "_loading", disabled: true, label: <div className="dock-hist-x"><Spin size="small" /></div> }]
    : (rows?.length ?? 0) === 0
      ? [
          { key: "_empty", disabled: true, label: <div className="dock-hist-x">这一页还没问过什么</div> },
          { type: "divider" as const },
          { key: "_all", label: <Link href="/dashboard">在首页看全部</Link> },
        ]
      : [
          ...(rows ?? []).map((r) => ({
            key: r.id,
            label: (
              <div className={`dock-hist-r${r.id === 当前 ? " on" : ""}`} title={r.title}>
                <span className="dock-hist-t">{r.title}</span>
                <span className="dock-hist-d">{时候(r.lastAskedAt)}</span>
              </div>
            ),
          })),
          { type: "divider" as const },
          { key: "_all", label: <Link href="/dashboard">在首页看全部</Link> },
        ];

  return (
    <>
      <button
        type="button"
        className="dock-b"
        onClick={() => 新起一屏(scope)}
        aria-label="新对话"
        title="新对话：这一屏清空，下一问另起一条"
      >
        <PlusOutlined />
      </button>
      <Dropdown
        trigger={["click"]}
        onOpenChange={打开}
        placement="bottomRight"
        menu={{
          items,
          // 「在首页看全部」是个 Link，交给它自己跳；别的 key 就是对话 id
          onClick: ({ key }) => {
            if (!key.startsWith("_")) void 载入(key);
          },
        }}
      >
        <button type="button" className="dock-b" aria-label="这一页的历史对话" title="历史：在这一页问过的">
          <HistoryOutlined />
        </button>
      </Dropdown>
    </>
  );
}

/**
 * 今天只给时分，别的给月日。
 * 和首页那条列表的「今天 / 昨天 / 更早」是同一个判断：按**本地日历天**比，
 * 不算「过去 24 小时」——早上问的那条到了晚上仍然该算今天。
 */
function 时候(iso: string): string {
  const d = dayjs(iso);
  return d.isSame(dayjs(), "day") ? d.format("HH:mm") : d.format("MM-DD");
}
