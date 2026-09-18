"use client";
/**
 * 侧栏最下面那枚反馈键。**它是「哪儿不好用」离开这台机器的唯一一条路**——
 * 在这之前，用得别扭的人只能截个图发微信，或者什么都不说就不用了。
 *
 * 坐在账号那一行的右端、更新键的右边：形状照 Claude / Codex 桌面端那枚小虫子，
 * 平时很淡，指上去才明显——它是个出口，不是一直举着手要人点的东西。
 *
 * 一起发出去的只有定位问题必须的几样：版本、系统、**当时在哪一页**。
 * 弹窗里把这句话写给人看，然后这里就得真的只发这些——不发学员、不发正文、不发日志。
 *
 * 自部署的开源版（去向 = github）不发请求：他的实例不该认识我们的云，
 * 点了直接开 GitHub issues，那也是 README 里写的那条路。
 */
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Modal, Input, Button, App } from "antd";
import { useBusiness } from "@/lib/business-client";

const ISSUES = "https://github.com/BeckY824/daedalus-crm/issues/new";

/**
 * 一只空的对话气泡。**不用小虫子**——那说的是「这里有 bug」，
 * 而这个口子收的多半不是 bug，是「这一步为什么要点两下」。空着不填三个点：
 * 里面该装的是你要说的话，图标先别替你说。
 * 自己画而不是拿现成图标：1.3 的线比 antd 那套细一档，它在账号那行是最轻的一个东西。
 */
function 气泡() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
      <path d="M2.6 2.5H13.4A1.6 1.6 0 0 1 15 4.1V9.9A1.6 1.6 0 0 1 13.4 11.5H6.9L4 13.8V11.5H2.6A1.6 1.6 0 0 1 1 9.9V4.1A1.6 1.6 0 0 1 2.6 2.5Z" />
    </svg>
  );
}

export default function FeedbackButton({ 去向 }: { 去向: "cloud" | "github" }) {
  const [open, setOpen] = useState(false);
  const [文字, set文字] = useState("");
  const [发送中, set发送中] = useState(false);
  const pathname = usePathname();
  const { message } = App.useApp();
  const b = useBusiness();

  function 点开() {
    if (去向 === "github") {
      window.open(ISSUES, "_blank", "noopener,noreferrer");
      return;
    }
    setOpen(true);
  }

  async function 发送() {
    const body = 文字.trim();
    if (!body) return;
    set发送中(true);
    try {
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, path: pathname, platform: navigator.userAgent }),
      });
      const 回 = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(回.error || "没发出去");
      // 收下了就说收下了，不额外承诺「我们会尽快回复」——回不回得看是什么事
      message.success("收到了，谢谢");
      setOpen(false);
      set文字("");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "没发出去");
    } finally {
      set发送中(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="rail-fb"
        onClick={点开}
        aria-label="反馈：说说哪儿不好用"
        title={去向 === "github" ? "反馈：到 GitHub 提 issue" : "反馈：说说哪儿不好用，或者哪儿出错了"}
      >
        <气泡 />
      </button>

      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        title="反馈"
        width={520}
        footer={null}
        destroyOnHidden
      >
        <Input.TextArea
          autoFocus
          value={文字}
          onChange={(e) => set文字(e.target.value)}
          placeholder="说说哪儿不好用，或者哪儿出错了。越具体越好：你点了什么、以为会怎样、实际怎样"
          autoSize={{ minRows: 5, maxRows: 12 }}
          maxLength={4000}
          /* ⌘/Ctrl+Enter 发送：这是个只有一个输入框的框，手不必离开键盘 */
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void 发送();
          }}
        />
        {/* 承诺写在人看得见的地方，不写在隐私政策的第七条里 */}
        <p className="fb-note">
          会一起发过去：版本、系统、你正在看的页面（{pathname}）。<b>不含任何{b.customer}、商机或跟进数据。</b>
        </p>
        <div className="fb-foot">
          <a href={ISSUES} target="_blank" rel="noopener noreferrer">
            也可以去 GitHub 提 issue
          </a>
          <span style={{ flex: 1 }} />
          <Button onClick={() => setOpen(false)}>取消</Button>
          <Button type="primary" loading={发送中} disabled={!文字.trim()} onClick={() => void 发送()}>
            发送
          </Button>
        </div>
      </Modal>
    </>
  );
}
