"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Alert, Button, Input, Space, Tag, Typography } from "antd";
import { CopyOutlined, SyncOutlined, TeamOutlined } from "@ant-design/icons";
import { smartTime } from "@/lib/utils";
import { 读团队状态, 建团队动作, 加入团队动作, 立即同步, 退出团队动作, 移除成员动作, 换邀请码动作 } from "./team-actions";

type 状态 = Awaited<ReturnType<typeof 读团队状态>>;

/**
 * 设置 → 团队（2026-10-03，0.46.15 团队同步）。只在桌面端本地模式有。
 *
 * 几个人各用各的桌面端，数据在每个人电脑上；改动加密后经我们的服务器转给同事。
 * 两句话必须说在明处：**我们看不到你们的数据**（钥匙只在邀请码里）；**邀请码只发给同事**（谁拿到谁就能进来、能解开）。
 * 新团队要开通才开始同步（收费）：建好、把人拉齐可以先做，开通了一起开始。
 */
export default function TeamTab() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [s, set] = useState<状态 | null>(null);
  const [名字, set名字] = useState("");
  const [码, set码] = useState("");
  const [忙, set忙] = useState<"建" | "入" | "同步" | null>(null);

  const 刷 = async () => set(await 读团队状态());
  useEffect(() => {
    let 还在 = true;
    void 读团队状态().then((x) => 还在 && set(x));
    return () => { 还在 = false; };
  }, []);

  const 复制 = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      message.success("邀请码已复制。只发给同事：拿到它的人就能进团队、看到全部数据");
    } catch {
      message.error("复制不了，请手动选中复制");
    }
  };

  async function 建() {
    set忙("建");
    const r = await 建团队动作(名字);
    set忙(null);
    if (!r.ok) return void message.error(r.error);
    set名字("");
    await 刷();
    router.refresh();
    modal.success({
      title: "团队建好了",
      content: (
        <div>
          <p>把下面这段邀请码发给同事，他们在自己的桌面端「设置 → 团队 → 加入团队」里粘贴进来。</p>
          <Typography.Paragraph copyable code style={{ wordBreak: "break-all" }}>{r.邀请码}</Typography.Paragraph>
          <p className="muted">团队还要开通才开始同步（收费）。可以先把人拉齐，开通了一起开始。</p>
        </div>
      ),
      okText: "知道了",
      width: 560,
    });
  }

  async function 入() {
    set忙("入");
    const r = await 加入团队动作(码);
    set忙(null);
    if (!r.ok) return void message.error(r.error);
    set码("");
    message.success(`已加入「${r.teamName}」${r.active ? "，正在同步" : "，团队开通后开始同步"}`);
    await 刷();
    router.refresh();
    if (r.active) void 同步();
  }

  async function 同步() {
    set忙("同步");
    const r = await 立即同步();
    set忙(null);
    if (!r.ok) message.error(r.error);
    else message.success(r.推 + r.拉 ? `同步好了：推了 ${r.推} 条、收到 ${r.拉} 条` : "已经是最新的了");
    await 刷();
    router.refresh();
  }

  function 移除(m: { accountId: string; name: string }) {
    modal.confirm({
      title: `把「${m.name}」移出团队？`,
      content: (
        <div>
          <p>之后的改动他收不到、也解不开；他也不能再往团队里推。</p>
          <p>邀请码和钥匙会一起换掉：其他同事下次同步时自动拿到新钥匙，不用做什么。<b>还没加入的人要用新邀请码</b>。</p>
          <p className="muted">他电脑上已经有的客户和记录收不回——那些本来就在他的电脑上。</p>
        </div>
      ),
      okText: "移出团队",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const r = await 移除成员动作(m.accountId, m.name);
        if (!r.ok) return void message.error(r.error);
        message.success(`已把「${m.name}」移出团队，邀请码和钥匙都换了`);
        await 刷();
      },
    });
  }

  function 换码() {
    modal.confirm({
      title: "换一个邀请码？",
      content: "旧邀请码立刻作废（发出去还没用的也不能用了），团队钥匙一起换。已经在团队里的同事不受影响，下次同步自动拿到新钥匙。邀请码发错人了就点这个。",
      okText: "换邀请码",
      cancelText: "取消",
      async onOk() {
        const r = await 换邀请码动作();
        if (!r.ok) return void message.error(r.error);
        message.success("邀请码换好了，旧的已作废");
        await 刷();
      },
    });
  }

  async function 用新码() {
    set忙("入");
    const r = await 加入团队动作(码);
    set忙(null);
    if (!r.ok) return void message.error(r.error);
    set码("");
    message.success("新钥匙收下了");
    await 刷();
    void 同步();
  }

  function 退() {
    modal.confirm({
      title: "退出团队？",
      content: "这台电脑上的数据全都留着，只是不再和同事同步：之后你改的他们看不到，他们改的你也收不到。要回来，找同事再要一次邀请码。",
      okText: "退出团队",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const r = await 退出团队动作();
        if (!r.ok) return void message.error(r.error);
        message.success("已退出团队");
        await 刷();
      },
    });
  }

  if (!s) return <div className="set-col muted" style={{ paddingTop: 8 }}>读取中…</div>;

  if (!s.在团队) {
    return (
      <div className="set-col team" style={{ paddingTop: 8 }}>
        <p className="team-intro">
          几个人各用各的桌面端，客户、跟进、商机、订单自动同步。数据在你们每个人的电脑上；
          改动加密后经我们的服务器转交，<b>钥匙只在你们的邀请码里，我们看不到内容</b>。
        </p>
        {!s.能用 && <Alert type="info" showIcon message="先在「桌面端」那一栏登录云端账号" style={{ marginBottom: 16 }} />}
        <section className="team-card">
          <h3>建一个团队</h3>
          <p className="muted">你是第一个用的人：建好之后把邀请码发给同事。这台电脑上已有的客户会一起带进团队。</p>
          <Space.Compact style={{ width: "100%", maxWidth: 420 }}>
            <Input value={名字} onChange={(e) => set名字(e.target.value)} placeholder="团队名字，如：明亮贸易" maxLength={40} aria-label="团队名字" disabled={!s.能用} onPressEnter={() => 名字.trim() && void 建()} />
            <Button type="primary" icon={<TeamOutlined />} loading={忙 === "建"} disabled={!s.能用 || !名字.trim() || 忙 !== null} onClick={() => void 建()}>建团队</Button>
          </Space.Compact>
        </section>
        <section className="team-card">
          <h3>加入同事的团队</h3>
          <p className="muted">把同事发来的邀请码整段粘贴进来（DT1. 开头）。你这台电脑上已有的客户也会同步给他们。</p>
          <Input.TextArea value={码} onChange={(e) => set码(e.target.value)} rows={2} placeholder="DT1.…" aria-label="邀请码" disabled={!s.能用} style={{ maxWidth: 560 }} />
          <div style={{ marginTop: 8 }}>
            <Button loading={忙 === "入"} disabled={!s.能用 || !码.trim() || 忙 !== null} onClick={() => void 入()}>加入团队</Button>
          </div>
        </section>
      </div>
    );
  }

  // 被移出了：只说清楚怎么回事、数据在哪、怎么回来，只留「退出团队」这一个动作（清掉这台电脑上的团队设置）
  if (s.被移出) {
    return (
      <div className="set-col team" style={{ paddingTop: 8 }}>
        <div className="team-head">
          <h3>{s.teamName}</h3>
          <Tag>已不在团队里</Tag>
        </div>
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`你已经不在「${s.teamName}」里了`}
          description="可能被建团队的人移出了，或者你在别的电脑上退出了。这台电脑上的数据都还在，只是不再和同事同步。要回来，找建团队的人要一个新的邀请码。"
        />
        <section className="team-card">
          <Button onClick={退}>退出团队</Button>
          <span className="muted" style={{ marginLeft: 12 }}>清掉这台电脑上的团队设置，之后可以建新团队或加入别的团队</span>
        </section>
      </div>
    );
  }

  return (
    <div className="set-col team" style={{ paddingTop: 8 }}>
      <div className="team-head">
        <h3>{s.teamName}</h3>
        {s.active === true && <Tag color="success">同步中</Tag>}
        {s.active === false && <Tag color="warning">待开通</Tag>}
        {s.active === null && <Tag>连不上云端</Tag>}
      </div>
      {s.active === false && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="团队还没开通，暂不同步" description="开通后自动开始，改动都记着，不会丢。开通请联系我们（设置 → 桌面端 → 反馈）。" />
      )}
      <div className="team-sync">
        <span className="muted">
          {s.lastSyncAt ? `上次同步 ${smartTime(s.lastSyncAt)}` : "还没同步过"}
          {s.last && (s.last.推 || s.last.拉) ? ` · 推了 ${s.last.推} 条、收到 ${s.last.拉} 条` : ""}
          {s.last?.撞 ? ` · 合并了 ${s.last.撞} 个同名渠道` : ""}
        </span>
        <Button icon={<SyncOutlined spin={忙 === "同步"} />} disabled={忙 !== null || s.active !== true} onClick={() => void 同步()}>立即同步</Button>
      </div>
      {/* 没开通时上面那条黄的已经说了，红的不再重复一遍 */}
      {s.lastError && !(s.active === false && /没开通/.test(s.lastError)) && <Alert type="error" showIcon message={s.lastError} style={{ marginBottom: 16 }} />}

      <section className="team-card">
        <h3>成员 {s.成员.length}</h3>
        <ul className="team-members">
          {s.成员.map((m) => (
            <li key={m.accountId}>
              <b>{m.name}</b>
              <span className="muted">{m.contact}</span>
              {m.role === "owner" && <Tag>建的人</Tag>}
              {/* 只有建团队的人能移除别人；自己不在这里移除（走「退出团队」） */}
              {s.我是建的人 && m.role !== "owner" && m.accountId !== s.我 && (
                <Button size="small" type="text" danger onClick={() => 移除(m)} aria-label={`移除 ${m.name}`}>移除</Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {s.重复.length > 0 && (
        <section className="team-card">
          <h3>疑似重复 {s.重复.length}</h3>
          <p className="muted">两个人各录了同一位客户、各建了同一家供应商时会出现在这里。同步不替你合并——号码一样不一定是同一个人。看一下，多的那条删掉。</p>
          <ul className="team-dupes">
            {s.重复.map((g) => (
              <li key={`${g.种类}${g.依据}`}>
                <span className="muted">{g.种类} · {g.依据}：</span>
                {g.记录.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && "、"}
                    <Link href={r.href}>{r.name}</Link>
                    {r.谁的 && <span className="muted">（{r.谁的}）</span>}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="team-card">
        <h3>邀请同事</h3>
        <p className="muted">把邀请码发给同事。<b>只发给同事</b>：拿到它的人就能进团队、看到全部数据。</p>
        <Space.Compact style={{ width: "100%", maxWidth: 560 }}>
          <Input value={s.邀请码} readOnly aria-label="邀请码" />
          <Button icon={<CopyOutlined />} onClick={() => void 复制(s.邀请码)}>复制</Button>
        </Space.Compact>
        {s.我是建的人 && (
          <div style={{ marginTop: 8 }}>
            <Button size="small" onClick={换码}>换邀请码</Button>
            <span className="muted" style={{ marginLeft: 8 }}>发错人了就换：旧码作废，钥匙一起换</span>
          </div>
        )}
      </section>

      {/* 这台没拿到自动转交的新钥匙（换钥匙之前没登记过设备）：粘建团队的人发来的新邀请码 */}
      {!s.我是建的人 && s.lastError && /新的邀请码/.test(s.lastError) && (
        <section className="team-card">
          <h3>粘贴新邀请码</h3>
          <Input.TextArea value={码} onChange={(e) => set码(e.target.value)} rows={2} placeholder="DT1.…" aria-label="新邀请码" style={{ maxWidth: 560 }} />
          <div style={{ marginTop: 8 }}>
            <Button type="primary" loading={忙 === "入"} disabled={!码.trim() || 忙 !== null} onClick={() => void 用新码()}>收下新钥匙</Button>
          </div>
        </section>
      )}

      <section className="team-card">
        <Button danger onClick={退}>退出团队</Button>
        <span className="muted" style={{ marginLeft: 12 }}>本机数据都留着，只是不再同步</span>
      </section>
    </div>
  );
}
