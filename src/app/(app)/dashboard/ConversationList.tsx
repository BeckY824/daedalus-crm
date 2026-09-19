"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { App, Dropdown, Input, Modal } from "antd";
import { PlusOutlined, MoreOutlined } from "@ant-design/icons";
import { 删掉对话的屏, 新起一屏, 当前对话, 首页屏 } from "@/lib/home-thread";
import { clearJob } from "@/lib/ai-jobs";
import { 重命名对话, 删除对话, type 对话概要 } from "./threads";
import WidthHandle, { 对话列表把手 } from "@/components/WidthHandle";

/**
 * 首页中栏：问过的对话。
 *
 * 在这之前首页那串问答只活在内存里，刷新即清，也开不出第二个——
 * 想把「这个月的回款」和「张三这条线怎么接」分开谈，只能两件事串在同一屏里。
 *
 * **只有自己看得见**（列表由服务端按 ownerId 查，见 threads.ts）。
 * 按最后一次提问倒序，分成今天 / 昨天 / 更早三组：找一条老对话时，
 * 人记得的是「前几天问过」，不是它叫什么名字。
 *
 * 不做的：搜索、置顶的界面、拖进项目。列表短的时候它们都是噪音，
 * 等一屏装不下再说（表结构里 pinnedAt / projectId 已经留好了）。
 */
export default function ConversationList({ rows }: { rows: 对话概要[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const { message, modal } = App.useApp();
  const [, startTransition] = useTransition();
  /** 正在改名的那条。null = 没有 */
  const [改名, set改名] = useState<{ id: string; title: string } | null>(null);

  const 选中 = sp.get("c") ?? 当前对话(首页屏) ?? "";

  function 新建() {
    新起一屏(首页屏);
    router.push("/dashboard");
  }

  function 打开(id: string) {
    if (id === 选中) return;
    router.push(`/dashboard?c=${id}`);
  }

  async function 存名字() {
    if (!改名) return;
    const r = await 重命名对话(改名.id, 改名.title);
    set改名(null);
    if (!r.ok) return void message.error("改不了这条对话");
    startTransition(() => router.refresh());
  }

  function 删(c: 对话概要) {
    modal.confirm({
      title: "删掉这条对话？",
      content: `「${c.title}」连同里面 ${c.条数} 条消息一起删掉，不能撤销。客户、跟进这些业务数据不受影响。`,
      okText: "删掉",
      okButtonProps: { danger: true },
      cancelText: "算了",
      onOk: async () => {
        const r = await 删除对话(c.id);
        if (!r.ok) return void message.error("删不掉这条对话");
        /*
          库里删了还不算删完：**每一页的面板各自存着一屏**（见 lib/home-thread），
          那几屏里还挂着这条对话问过的话。2026-09-19 报上来的：在这条列表里把对话
          全删了，回到数据页、线索页，面板里那几句问过的话还在——人以为删干净了。
          所以按对话 id 把所有挂在它名下的屏一并空掉，对应的任务（答案存在那儿）也清掉。
        */
        for (const id of 删掉对话的屏(c.id)) clearJob(`home:${id}`);
        // 删的正好是开着的那条：回到一屏新对话
        if (c.id === 选中) {
          新起一屏(首页屏);
          router.push("/dashboard");
        }
        startTransition(() => router.refresh());
      },
    });
  }

  const 组 = 分组(rows);

  return (
    <aside className="pane pane-chat">
      {/* 和左栏同一条能拖的缝：这一列装的是一句句问过的话，多长不是我们定的 */}
      <WidthHandle 规格={对话列表把手} />
      <div className="pane-h">
        <span className="pane-t">
          对话
          {rows.length > 0 && <span className="pane-n">{rows.length}</span>}
        </span>
      </div>

      <div className="pane-rows">
        {/* 一整行，图标带着字。页头上一颗光秃秃的加号没人认得出它是「新建对话」 */}
        <button type="button" className="chat-new" onClick={新建}>
          <PlusOutlined />
          新建对话
        </button>
        {rows.length === 0 ? (
          <div className="pane-empty">还没有问过什么。在右边问一句，这里就会留下一条。</div>
        ) : (
          组.map(([名, 条目]) =>
            条目.length === 0 ? null : (
              <section key={名} className="chat-g">
                <div className="chat-g-h">{名}</div>
                {条目.map((c) => (
                  <div key={c.id} className={`chat-row${c.id === 选中 ? " on" : ""}`}>
                    <button type="button" className="chat-row-b" onClick={() => 打开(c.id)} title={c.title}>
                      {c.title}
                    </button>
                    <Dropdown
                      trigger={["click"]}
                      menu={{
                        items: [
                          { key: "rename", label: "重命名" },
                          { key: "delete", label: "删掉", danger: true },
                        ],
                        onClick: ({ key }) => (key === "rename" ? set改名({ id: c.id, title: c.title }) : 删(c)),
                      }}
                    >
                      <button type="button" className="chat-row-m" aria-label={`${c.title} 的操作`}>
                        <MoreOutlined />
                      </button>
                    </Dropdown>
                  </div>
                ))}
              </section>
            ),
          )
        )}
      </div>

      <Modal
        open={改名 !== null}
        title="重命名对话"
        onCancel={() => set改名(null)}
        onOk={存名字}
        okText="保存"
        cancelText="取消"
        width={420}
      >
        <Input
          autoFocus
          maxLength={60}
          value={改名?.title ?? ""}
          onChange={(e) => set改名((v) => (v ? { ...v, title: e.target.value } : v))}
          onPressEnter={存名字}
          placeholder="这条对话叫什么"
        />
      </Modal>
    </aside>
  );
}

/**
 * 今天 / 昨天 / 更早。
 *
 * 用**本地日期**比，不算「过去 24 小时」：早上问的那条到了晚上仍然该在「今天」，
 * 而不是因为超过 24 小时跳进「更早」。
 */
function 分组(rows: 对话概要[]): [string, 对话概要[]][] {
  const 日 = (s: string) => {
    const d = new Date(s);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const now = new Date();
  const 今 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const 昨 = 今 - 86_400_000;
  const out: Record<string, 对话概要[]> = { 今天: [], 昨天: [], 更早: [] };
  for (const r of rows) {
    const d = 日(r.lastAskedAt);
    out[d >= 今 ? "今天" : d >= 昨 ? "昨天" : "更早"].push(r);
  }
  return [["今天", out.今天], ["昨天", out.昨天], ["更早", out.更早]];
}
