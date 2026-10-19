"use client";
/**
 * 「粘贴询盘邮件」（背调补充方案第二期，2026-10-18）：背调模式里点一下，把询盘邮件的原文（带邮件头）粘进来。
 *
 * **原文只在这台电脑的浏览器里解析**（lib/research/verify/mail.ts，纯函数），交出去的只有认出来的几样：
 * 发件人、回复地址、发件 IP、SPF / DKIM / DMARC、签名里的电话和税号。原文不进请求、不进库、关掉就没了。
 * 背调时发件人和电话照手填的一样拿去核；发件 IP 在本机的离线库里查国家，也不发出去。
 */
import { useMemo, useState } from "react";
import { Modal, Input } from "antd";
import { 像邮件原文, 解析邮件, 换了回复地址, type 邮件信号 } from "@/lib/research/verify/mail";
import "./research.css";

const 结论字: Record<string, string> = { pass: "通过", fail: "不通过", softfail: "软失败", neutral: "中立", none: "没设", temperror: "临时出错", permerror: "配置错", policy: "按策略放行" };

/** 一句话说清这封信认出了什么（输入框上方那一条也用） */
export function 邮件摘要(x: 邮件信号): string {
  const ip = x.发件IP ? `发件 IP ${x.发件IP}` : x.经手 ? `经${x.经手}发出，看不到对方 IP` : "没认出发件 IP";
  return [x.发件人 ?? "没认出发件人", ip].join(" · ");
}

export default function MailPaste({ open, 初值, onCancel, onOk }: { open: boolean; 初值?: string; onCancel: () => void; onOk: (x: 邮件信号) => void }) {
  const [文, set文] = useState(初值 ?? "");
  const [上次初值, set上次初值] = useState(初值);
  // 从输入框里直接粘进来的：换一份初值就换掉框里的
  if (初值 !== 上次初值) {
    set上次初值(初值);
    set文(初值 ?? "");
  }
  const 像 = 文.trim() ? 像邮件原文(文) : null;
  const 信 = useMemo(() => (像 ? 解析邮件(文) : null), [像, 文]);
  const 能带 = Boolean(信 && (信.发件人 || 信.发件IP || 信.经手));
  const 关 = () => {
    set文("");
    onCancel();
  };
  return (
    <Modal
      open={open}
      title="粘贴询盘邮件"
      onCancel={关}
      okText="带上这封邮件"
      cancelText="取消"
      okButtonProps={{ disabled: !能带 }}
      onOk={() => {
        if (!信 || !能带) return;
        onOk(信);
        set文("");
      }}
      width={560}
      destroyOnHidden
    >
      <p className="mp-help">
        把询盘邮件的<b>原文</b>（带邮件头）粘进来：在邮箱里打开这封信，点「显示原始邮件」「查看邮件源」或「显示邮件原文」，全选复制。
      </p>
      <Input.TextArea
        className="mp-ta"
        value={文}
        onChange={(e) => set文(e.target.value)}
        autoSize={{ minRows: 6, maxRows: 12 }}
        placeholder={"Received: from …\nFrom: John <john@example.com>\nSubject: Inquiry for LED street lights\n…"}
        autoFocus
        aria-label="询盘邮件原文"
      />
      {像 === false && <p className="mp-warn">这段不像邮件原文（没有 Received、From 这些邮件头）。只粘正文认不出发件 IP，要粘「原始邮件」那一份。</p>}
      {信 && (
        <dl className="mp-got" aria-label="认出来的">
          <dt>发件人</dt>
          <dd>{信.发件人 ?? "没认出"}</dd>
          {信.回复到 && (
            <>
              <dt>回复地址</dt>
              <dd className={换了回复地址(信) ? "mp-bad" : undefined}>
                {信.回复到}
                {换了回复地址(信) && "（和发件人不是一个域名，留意）"}
              </dd>
            </>
          )}
          <dt>发件 IP</dt>
          <dd>{信.发件IP ? `${信.发件IP}（${信.IP来源 === "X-Originating-IP" ? "原始发件 IP" : "最早一跳"}，背调时在本机查国家）` : 信.经手 ? `经${信.经手}发出，看不到对方自己的 IP（不扣分）` : "没认出"}</dd>
          {(信.spf || 信.dkim || 信.dmarc) && (
            <>
              <dt>发件认证</dt>
              <dd>
                {(["spf", "dkim", "dmarc"] as const)
                  .filter((k) => 信[k])
                  .map((k) => `${k.toUpperCase()} ${结论字[信[k]!] ?? 信[k]}`)
                  .join("、")}
              </dd>
            </>
          )}
          {信.电话.length > 0 && (
            <>
              <dt>签名里的电话</dt>
              <dd>{信.电话.join("、")}</dd>
            </>
          )}
          {信.税号 && (
            <>
              <dt>税号</dt>
              <dd>{信.税号}</dd>
            </>
          )}
        </dl>
      )}
      <p className="mp-note">
        只在这台电脑上解析，原文不上传、不保存；认出的发件人、电话会和手填的一样拿去核。Gmail、Outlook 网页版发的信看不到对方 IP，这一项不扣分。
      </p>
    </Modal>
  );
}
