"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Alert, Button, Input, Space, Switch, Tag, Typography } from "antd";
import { useCopy } from "@/lib/clipboard";
import { CopyOutlined, SyncOutlined, TeamOutlined } from "@ant-design/icons";
import { smartTime } from "@/lib/utils";
import ScopeConflicts from "./ScopeConflicts";
import OverwrittenCard from "./OverwrittenCard";
import TrashCard from "./TrashCard";
import DevicesCard from "./DevicesCard";
import ConnectCard from "./ConnectCard";
import TeamPricing from "./TeamPricing";
import TeamNoticeCard from "./TeamNoticeCard";
import DupeMergeCard from "./DupeMergeCard";
import DeptCard from "./DeptCard";
import { 人满话 } from "@/lib/team-pricing";
import { 没同步上分钟 } from "@/lib/sync/sync-age";
import { 读团队状态, 读同步时间, 建团队动作, 加入团队动作, 立即同步, 退出团队动作, 移除成员动作, 换邀请码动作, 设互看动作, 设角色动作 } from "./team-actions";

type 状态 = Awaited<ReturnType<typeof 读团队状态>>;

/**
 * 设置 → 团队（2026-10-03，0.46.15 团队同步）。只在桌面端本地模式有。
 *
 * 几个人各用各的桌面端，数据在每个人电脑上；改动加密后经我们的服务器转给同事。
 * 两句话必须说在明处：**我们看不到你们的数据**（钥匙只在邀请码里）；**邀请码只发给同事**（谁拿到谁就能进来、能解开）。
 * 新团队要开通才开始同步（2026-10-28 起团队版免费，开通照旧由运营者开）：建好、把人拉齐可以先做，开通了一起开始。
 * 2026-10-15 起按时长开通：有到期日（显示还剩几天），到期暂停同步、续期自动恢复；10-28 起不标价（TeamPricing 只说免费）。
 */
export default function TeamTab() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [s, set] = useState<状态 | null>(null);
  const [名字, set名字] = useState("");
  const [码, set码] = useState("");
  const [忙, set忙] = useState<"建" | "入" | "同步" | null>(null);

  const [现在, set现在] = useState(() => Date.now());

  const 刷 = async () => set(await 读团队状态());
  useEffect(() => {
    let 还在 = true;
    void 读团队状态().then((x) => 还在 && set(x));
    return () => { 还在 = false; };
  }, []);
  /*
    「上次同步」跟着走（2026-10-23 用户报看到的时间停在两个小时前）：原来只在打开这一栏时读一次，后台照常在同步也不变。
    开着、看得见时每 10 秒读一次本机记的时间（不问云端），切回来马上读一次
  */
  useEffect(() => {
    let 还在 = true;
    const 读 = async () => {
      if (document.visibilityState !== "visible") return;
      const t = await 读同步时间().catch(() => null);
      if (!还在) return;
      set现在(Date.now());
      // 有了新的一轮才换：lastError 可能是打开时问云端问出来的（连不上云端），本机文件里没有，别把它盖掉
      if (t) set((x) => (x && x.在团队 && (t.lastSyncAt !== x.lastSyncAt || t.跑过一轮 !== x.跑过一轮) ? { ...x, ...t } : x));
    };
    const 闹 = setInterval(() => void 读(), 10_000);
    const 回来 = () => void 读();
    window.addEventListener("focus", 回来);
    document.addEventListener("visibilitychange", 回来);
    return () => {
      还在 = false;
      clearInterval(闹);
      window.removeEventListener("focus", 回来);
      document.removeEventListener("visibilitychange", 回来);
    };
  }, []);

  const 拷 = useCopy();
  const 复制 = (t: string) => 拷(t, "邀请码已复制。只发给同事：拿到它的人就能进团队");

  async function 建() {
    // 回车也能触发：转圈时再按一下会在云端建出第二个团队（10-08 发版前审查）
    if (忙 !== null) return;
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
          <p className="muted">团队还要开通才开始同步（团队版免费）。可以先把人拉齐，开通了一起开始。</p>
        </div>
      ),
      okText: "知道了",
      width: 560,
    });
  }

  async function 入() {
    if (忙 !== null) return;
    set忙("入");
    const r = await 加入团队动作(码);
    set忙(null);
    if (!r.ok) return void message.error(r.error);
    set码("");
    message.success(`已加入「${r.teamName}」${r.active ? "，正在同步" : "，团队开通后开始同步"}。模版和币种跟建团队的人用同一套`);
    await 刷();
    router.refresh();
    if (r.active) void 同步();
  }

  async function 同步() {
    set忙("同步");
    const r = await 立即同步();
    set忙(null);
    set现在(Date.now());
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
          <p className="muted">他点「退出团队」时，他电脑上同事的客户会删掉、只留他自己负责的；不点的话那些数据还在他电脑上（只是界面上看不到），收不回。</p>
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

  /** 设业务主管 / 改回业务员（2026-10-20）：先说清主管能做什么、不能做什么 */
  function 设主管(m: { accountId: string; name: string }, 设: boolean) {
    modal.confirm({
      title: 设 ? `把「${m.name}」设成业务主管？` : `把「${m.name}」改回业务员？`,
      content: (
        <div data-testid="team-role-confirm">
          {设 ? (
            <>
              <p>业务主管看得到<b>全队</b>的客户和跟进（不管「同事之间互相看得到客户」开没开），能分配客户、把公海客户指派给业务员、处理疑似重复。</p>
              <p>加人、移除成员、看邀请码、改业务配置、拨开关、设别人的角色还是只有你能做。</p>
            </>
          ) : (
            <p>改回后只看得到自己负责的客户和公海；下次同步时，他电脑上同事的客户会删掉。<b>已经看过、导出过的收不回</b>。</p>
          )}
        </div>
      ),
      okText: 设 ? "设为主管" : "改回业务员",
      cancelText: "取消",
      async onOk() {
        const r = await 设角色动作(m.accountId, m.name, 设 ? "manager" : "member");
        if (!r.ok) return void message.error(r.error);
        message.success(设 ? `「${m.name}」现在是业务主管，他下次同步后看得到全队` : `「${m.name}」改回业务员了`);
        await 刷();
      },
    });
  }

  /** 「同事之间互相看得到客户」：开、关都先说清两件事——放开了什么 / 收回什么，以及看过、导出过的收不回 */
  function 切互看(on: boolean) {
    modal.confirm({
      title: on ? "让同事之间互相看得到客户？" : "关掉「同事之间互相看得到客户」？",
      content: (
        <div data-testid="team-share-confirm">
          {on ? (
            <p>业务员会看到<b>全队</b>的客户、跟进记录和商机进度（列表、搜索、首页、AI、导出都算）。同事的客户只能看和加跟进，改资料、删除、转交还是负责人和你。</p>
          ) : (
            <p>业务员下次同步后只看得到自己的客户和公海，他们电脑上同事的客户会删掉。</p>
          )}
          <p><b>已经看过、导出过的收不回</b>{on ? "：以后再关掉，业务员电脑上同事的客户会删掉，但导出的表格、记下来的东西还在。" : "：导出的表格、记下来的东西还在他们那里。"}</p>
        </div>
      ),
      okText: on ? "打开" : "关掉",
      cancelText: "取消",
      async onOk() {
        const r = await 设互看动作(on);
        if (!r.ok) return void message.error(r.error);
        message.success(on ? "已打开：业务员下次同步后看得到全队客户" : "已关掉：业务员下次同步后只看自己的和公海");
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
      content: s?.在团队 && s.我是建的人
        ? "这台电脑上的数据全都留着，只是不再和同事同步。你这个账号的其它电脑和手机也会一起退出。你是老板：团队里还有同事时要先把他们移除。"
        : "退出后这台电脑上只留你自己负责的客户（连同跟进、商机），同事的客户会从这台电脑上删掉；之后也不再和同事同步。你这个账号的其它电脑和手机也会一起退出。只想停用某一台，到「我的设备」里移除它。要回来，找老板再要一次邀请码。",
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
    // 账号在云上已经是团队成员、这台还没连上（新电脑登录同一个账号）：先给「在另一台电脑上允许」，邀请码放在后面（2026-10-15 多设备同步）
    const 云上 = "连接" in s ? s.连接 : null;
    // 云端没答上来（超时、断网、5xx）：不知道账号在不在团队里，不摆「建一个团队」，免得建出第二个（2026-10-28 D-03）
    const 问不到 = s.能用 && (!云上 || 云上.问不到);
    return (
      <div className="set-col team" style={{ paddingTop: 8 }}>
        <p className="team-intro">
          几个人各用各的桌面端，客户、跟进、商机自动同步。数据在你们每个人的电脑上；
          改动加密后经我们的服务器转交，<b>钥匙只在你们的电脑和邀请码里，我们看不到内容</b>。
        </p>
        {!s.能用 && <Alert type="info" showIcon message="先在「桌面端」那一栏登录云端账号" style={{ marginBottom: 16 }} />}
        {问不到 && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }} data-testid="team-cloud-unreachable"
            title="暂时连不上云端"
            description="查不到你的账号是不是已经在团队里。稍后再试；要是同事已经把邀请码发给你，也可以直接在下面粘贴加入。"
            action={<Button size="small" onClick={() => void 刷()}>重试</Button>} />
        )}
        {云上?.云上的团 && (
          <ConnectCard 团名={云上.云上的团.name} 我是建的人={云上.云上的团.我是建的人} 等授权={云上.等授权} 本机客户={云上.本机客户}
            onJoined={() => { void 刷(); router.refresh(); }} />
        )}
        {!云上?.云上的团 && !问不到 && <section className="team-card">
          <h3>建一个团队</h3>
          <p className="muted">建团队的人就是老板：看得到所有人的客户和跟进。建好之后把邀请码发给同事，他们进来是业务员。这台电脑上已有的客户会一起带进团队。</p>
          <Space.Compact style={{ width: "100%", maxWidth: 420 }}>
            <Input value={名字} onChange={(e) => set名字(e.target.value)} placeholder="团队名字，如：明亮贸易" maxLength={40} aria-label="团队名字" disabled={!s.能用} onPressEnter={() => 名字.trim() && void 建()} />
            <Button type="primary" icon={<TeamOutlined />} loading={忙 === "建"} disabled={!s.能用 || !名字.trim() || 忙 !== null} onClick={() => void 建()}>建团队</Button>
          </Space.Compact>
        </section>}
        <section className="team-card">
          <h3>{云上?.云上的团 ? "另一台电脑不在身边：用邀请码连接" : "加入同事的团队"}</h3>
          <p className="muted">
            {云上?.云上的团
              ? "找老板要一个邀请码（DT2. 开头）整段粘贴进来，效果一样。"
              : "把老板发来的邀请码整段粘贴进来（DT2. 开头）。进来之后你是业务员：看得到自己负责的客户和公海；你这台电脑上已有的客户归你，老板也看得到。团队的模版和币种以建团队的人为准，你这台原来设的会换成老板那套。"}
          </p>
          <Input.TextArea value={码} onChange={(e) => set码(e.target.value)} rows={2} placeholder="DT2.…" aria-label="邀请码" disabled={!s.能用} style={{ maxWidth: 560 }} />
          <div style={{ marginTop: 8 }}>
            <Button loading={忙 === "入"} disabled={!s.能用 || !码.trim() || 忙 !== null} onClick={() => void 入()}>加入团队</Button>
          </div>
        </section>
        <TeamPricing />
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
          description="可能被老板移出了，或者你在别的电脑上退出了。这台电脑上的数据都还在，只是不再和同事同步。要回来，找老板要一个新的邀请码。"
        />
        <section className="team-card">
          <Button onClick={退}>退出团队</Button>
          <span className="muted" style={{ marginLeft: 12 }}>清掉这台电脑上的团队设置，只留你自己负责的客户；之后可以建新团队或加入别的团队</span>
        </section>
      </div>
    );
  }

  return (
    <div className="set-col team" style={{ paddingTop: 8 }}>
      <div className="team-head">
        <h3>{s.teamName}</h3>
        {s.active === true && <Tag color="success">同步中</Tag>}
        {s.active === false && (s.已到期 ? <Tag color="error">已到期</Tag> : <Tag color="warning">待开通</Tag>)}
        {s.active === null && <Tag>连不上云端</Tag>}
      </div>
      {/* 有效期（2026-10-15 按时长开通）：没有到期日 = 不限期，不显示这一行 */}
      {s.active === true && s.到期 && (
        <p className="muted team-plan" data-testid="team-plan">
          有效期至 {s.到期.日}（{s.到期.剩 > 0 ? `还剩 ${s.到期.剩} 天` : "今天到期"}）
          {s.席位 ? ` · 人数上限 ${s.席位} 人，现在 ${s.成员.length} 人` : ""}
        </p>
      )}
      {s.active === true && s.到期 && s.到期.剩 <= 7 && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title={s.到期.剩 > 0 ? `团队同步还有 ${s.到期.剩} 天到期` : "团队同步今天到期"}
          description={s.我是建的人
            ? "到期后暂停同步（这台电脑上的数据照常能用）。续期请点左下角「反馈」告诉我们团队名字和人数，续上之后接着同步。"
            : "到期后暂停同步（这台电脑上的数据照常能用）。续期由老板办，提醒老板一声就行。"} />
      )}
      {s.active === false && s.已到期 && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title={`团队同步已到期${s.到期 ? `（${s.到期.日}）` : ""}，暂停同步`}
          description={s.我是建的人
            ? "这台电脑上的数据照常能用，改动都记着，不会丢。续期请点左下角「反馈」告诉我们团队名字和人数；续上之后自动恢复，把这段时间的改动补上。"
            : "这台电脑上的数据照常能用，改动都记着，不会丢。请老板续期；续上之后自动恢复，把这段时间的改动补上。"} />
      )}
      {s.active === false && !s.已到期 && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="团队还没开通，暂不同步"
          description={s.我是建的人
            ? "开通后自动开始，改动都记着，不会丢。团队版免费；开通请点左下角的「反馈」告诉我们团队名字和人数。"
            : "开通后自动开始，改动都记着，不会丢。开通由老板办，等老板开通就行。"} />
      )}
      <div className="team-sync">
        <span className="muted">
          {s.lastSyncAt ? `上次同步 ${smartTime(s.lastSyncAt)}` : "还没同步过"}
          {s.last && (s.last.推 || s.last.拉) ? ` · 推了 ${s.last.推} 条、收到 ${s.last.拉} 条` : ""}
          {s.last?.撞 ? ` · 合并了 ${s.last.撞} 个同名渠道` : ""}
        </span>
        <Button icon={<SyncOutlined spin={忙 === "同步"} />} disabled={忙 !== null || s.active !== true} onClick={() => void 同步()}>立即同步</Button>
      </div>
      {s.active === true && 没同步上分钟(s, 现在) !== null && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }}
          title={`已经 ${时长(没同步上分钟(s, 现在)!)}没同步上了`}
          description="同事的改动可能还没收到，你这边的改动也可能还没发出去。点右边「立即同步」马上试一次；一直这样，请点左下角「反馈」告诉我们。"
          action={<Button size="small" disabled={忙 !== null} onClick={() => void 同步()}>立即同步</Button>} />
      )}
      {/* 云端没答上来：名单、开通状态先显示不了，说清楚、给重试；本机照常能用（2026-10-28 D-03） */}
      {s.连不上 && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} data-testid="team-cloud-unreachable"
          title="暂时连不上云端"
          description="成员名单、开通状态先显示不了。这台电脑上的客户照常能用，改动都记着，连上后自动同步。"
          action={<Button size="small" disabled={忙 !== null} onClick={() => void 刷()}>重试</Button>} />
      )}
      {/* 没开通、到期时上面那条黄的已经说了，红的不再重复一遍；连不上云端上面那条已经说了 */}
      {s.lastError && !s.连不上 && !(s.active === false && /没开通|已到期/.test(s.lastError)) && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }}
          // 「登录已失效」是云端那边的原话，人不知道去哪登录、为什么失效（多半是在别的设备上把这台从「我的设备」里移除了）
          message={/登录已失效/.test(s.lastError) ? "这台电脑的云端登录失效了，暂停同步" : s.lastError}
          description={/登录已失效/.test(s.lastError) ? "可能在你的另一台设备上把这台从「我的设备」里移除了，或者改过密码。到「桌面端」那一栏重新登录；要是移除过，登录后点下面的「退出团队」，再按提示连回来。" : undefined} />
      )}
      {/* 回放时撞了合不了的（两条线索挂同一位客户、同事账号登录名撞了）：这几条两台对不上，说出来（T-003），不静默 */}
      {s.没同步上.条数 > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`有 ${s.没同步上.条数} 条没同步上`}
          description={
            <>
              同事那边的这几条和这台电脑上已有的撞在一起、合不了，两台各留着自己的那条
              {s.没同步上.例子.length > 0 && `（${s.没同步上.例子.map((x) => `${x.表}：${x.原因}`).join("；")}）`}
              。请和同事对一下，在一台上删掉或改掉多出来的那条；之后的改动照常同步。
            </>
          }
        />
      )}

      {/* 范围同步：失权的未上传改动（不静默丢弃）；AI 历史只统计不删除，见 docs/范围同步迁移说明.md */}
      <ScopeConflicts onChange={() => void 刷()} />
      {/* 和同事同时改了同一格、被同事后来的改动盖掉的：把我原来写的给我看（lib/sync/overwritten.ts） */}
      <OverwrittenCard onChange={() => void 刷()} />
      {/* 同事删掉的客户：老板那台删之前留了一份，30 天内能放回去（lib/sync/trash.ts） */}
      {(s.我是建的人 || s.我是主管) && <TrashCard onChange={() => void 刷()} />}
      {(s.范围?.清理?.AI残留 ?? 0) > 0 && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} data-testid="scope-ai-residue"
          message={`AI 对话历史里有 ${s.范围!.清理!.AI残留} 条提到了已不在你同步范围内的客户`}
          description="升级只清理了客户资料本身；AI 历史不会自动删除，以免误删你自己的记录。需要的话请在 AI 对话列表里自行删除。" />
      )}

      <section className="team-card">
        <h3>成员 {s.连不上 && s.成员.length === 0 ? "" : s.成员.length}</h3>
        <p className="muted" data-testid="team-role-intro">
          {s.我是建的人
            ? `你是老板：看得到所有人的客户和跟进，在下面可以把业务员设成业务主管。业务主管看得到全队、能分配客户和处理重复；${s.互看 ? "业务员也看得到全队的客户（同事的只能看和加跟进）。" : "业务员只看得到自己负责的客户和公海。"}`
            : s.我是主管
              ? "你是业务主管：看得到全队的客户和跟进，能分配客户、把公海客户指派给业务员、处理疑似重复。加人、移除成员、邀请码和业务配置由老板管。"
              : s.互看 ? "你是业务员：团队开了「同事之间互相看得到客户」，看得到全队的客户；同事的只能看和加跟进。老板和业务主管看得到全部。" : "你是业务员：看得到自己负责的客户和公海里的客户。老板和业务主管看得到全部。"}
        </p>
        <ul className="team-members">
          {s.成员.map((m) => {
            const 概况 = "每人" in s ? s.每人[m.accountId] : undefined;
            return (
            <li key={m.accountId}>
              <b>{m.name}</b>
              <span className="muted">{m.contact}</span>
              <Tag color={m.role === "owner" ? "gold" : m.role === "manager" ? "blue" : undefined}>{m.role === "owner" ? "老板" : m.role === "manager" ? "业务主管" : "业务员"}</Tag>
              {/* 老板看每个人的跟进过程：近 7 天几次、最近一次，点进去是这个人的跟进 / 客户 */}
              {概况 && (
                <span className="team-member-stat">
                  <Link href={`/customers?salesOwnerId=${encodeURIComponent(概况.userId)}`}>客户 {概况.客户}</Link>
                  <Link href={`/follow-ups?ownerId=${encodeURIComponent(概况.userId)}`}>
                    近 7 天跟进 {概况.近7天跟进} 次{概况.最近跟进 ? ` · 最近 ${smartTime(概况.最近跟进)}` : ""}
                  </Link>
                </span>
              )}
              {/* 设主管（2026-10-20）：只有老板；不要签名钥匙，老板在哪台电脑上都能改。新服务器带编制时改在下面「部门与权限」里设角色 */}
              {s.我是建的人 && !s.编制 && m.role !== "owner" && m.accountId !== s.我 && (
                <Button size="small" type="link" onClick={() => 设主管(m, m.role !== "manager")} aria-label={`${m.role === "manager" ? "改回业务员" : "设为主管"} ${m.name}`}>
                  {m.role === "manager" ? "改回业务员" : "设为主管"}
                </Button>
              )}
              {/* 只有建团队的人能移除别人；自己不在这里移除（走「退出团队」） */}
              {s.我是建的人 && s.能管理 && m.role !== "owner" && m.accountId !== s.我 && (
                <Button size="small" type="text" danger onClick={() => 移除(m)} aria-label={`移除 ${m.name}`}>移除</Button>
              )}
            </li>
            );
          })}
        </ul>
      </section>

      {/* 部门与权限（团队版 1b，2026-10-23）：老服务器不带编制就不摆，照旧用上面的「设为主管」 */}
      {s.编制 && <DeptCard 编制={s.编制} 成员={s.成员} 我是建的人={s.我是建的人} 我={s.我} onChange={() => void 刷()} />}

      {/* 同事之间互相看得到客户（2026-10-20，客户需求）：整个团队一个开关，只有老板能改；老服务器不认（null）就不摆 */}
      {s.我是建的人 && s.互看 !== null && (
        <section className="team-card team-share" data-testid="team-share">
          <div className="team-share-row">
            <h3 style={{ margin: 0 }}>同事之间互相看得到客户</h3>
            <Switch checked={s.互看} onChange={(on) => 切互看(on)} aria-label="同事之间互相看得到客户" />
          </div>
          <p className="muted">
            打开后业务员能看到全队的客户、跟进记录和商机进度；同事的客户只能看和加跟进，改资料、删除、转交还是负责人和你。
            关掉后回到「只看自己的 + 公海」，业务员电脑上同事的客户在下次同步时删掉。
          </p>
          <p className="team-share-warn">已经看过、导出过的收不回。</p>
        </section>
      )}

      {/* 疑似重复：合并成一份 / 不是同一个人（2026-10-20，老板和业务主管；业务员那边 重复 是空的） */}
      {(s.我是建的人 || s.我是主管) && <DupeMergeCard 组们={s.重复} 上次合并={s.上次合并} 叫法={s.叫法} 变了={刷} />}

      {/* 老板：同事新建客户 / 商机时这台弹通知（desktop/team-notices.js） */}
      {s.我是建的人 && <TeamNoticeCard />}

      {/* 我的设备：本人的电脑和手机，本人授权、本人移除（老板也替不了业务员点） */}
      <DevicesCard />

      {!s.我是建的人 && (
        <section className="team-card">
          <h3>邀请同事</h3>
          <p className="muted">要加人找老板（建团队的人）要邀请码。</p>
        </section>
      )}

      {s.我是建的人 && (
      <section className="team-card">
        <h3>邀请同事</h3>
        <p className="muted">把邀请码发给同事，他们进来就是业务员。<b>只发给同事</b>：拿到它的人就能进团队。</p>
        {/* 席位要拦（2026-10-19，lib/tenant/team-plan.ts 席位闸）：满了同事拿着邀请码也进不来，先说在这里 */}
        {s.席位 && s.成员.length >= s.席位 ? (
          <Alert type="warning" showIcon style={{ marginBottom: 12, maxWidth: 560 }} data-testid="team-seats-full"
            title={人满话(s.席位)} description="已经在团队里的人照常用；同事拿着邀请码也进不来。开通时定的人数就是上限，要改请私信我们。" />
        ) : null}
        <Space.Compact style={{ width: "100%", maxWidth: 560 }}>
          <Input value={s.邀请码 || "这台看不到邀请码"} readOnly aria-label="邀请码" disabled={!s.邀请码} />
          <Button icon={<CopyOutlined />} disabled={!s.邀请码} onClick={() => void 复制(s.邀请码)}>复制</Button>
        </Space.Compact>
        {s.能管理 ? (
          <div style={{ marginTop: 8 }}>
            <Button size="small" onClick={换码}>换邀请码</Button>
            <span className="muted" style={{ marginLeft: 8 }}>发错人了就换：旧码作废，钥匙一起换</span>
          </div>
        ) : (
          // 老板在另一台电脑上进来的：签名钥匙不在这台，换出去的钥匙同事会拒收（lib/sync/client 的 能管理团队）
          <p className="muted" style={{ marginTop: 8 }}>
            移除同事、换邀请码{s.邀请码 ? "" : "、看邀请码"}要在<b>建团队的那台电脑</b>（或它授权连上的电脑）上做：老板的管理钥匙只在那几台上。
            这台是用邀请码或在手机上批准连上的，没有。
          </p>
        )}
      </section>
      )}

      {/* 这台没拿到自动转交的新钥匙（换钥匙之前没登记过设备）：粘建团队的人发来的新邀请码 */}
      {!s.我是建的人 && s.lastError && /新的邀请码/.test(s.lastError) && (
        <section className="team-card">
          <h3>粘贴新邀请码</h3>
          <Input.TextArea value={码} onChange={(e) => set码(e.target.value)} rows={2} placeholder="DT2.…" aria-label="新邀请码" style={{ maxWidth: 560 }} />
          <div style={{ marginTop: 8 }}>
            <Button type="primary" loading={忙 === "入"} disabled={!码.trim() || 忙 !== null} onClick={() => void 用新码()}>收下新钥匙</Button>
          </div>
        </section>
      )}

      <TeamPricing />

      <section className="team-card">
        <Button danger onClick={退}>退出团队</Button>
        <span className="muted" style={{ marginLeft: 12 }}>你这个账号的电脑和手机都不再同步（本机数据留着）；只停用一台请到「我的设备」里移除</span>
      </section>
    </div>
  );
}

function 时长(分: number) {
  return 分 < 60 ? `${分} 分钟` : `${Math.floor(分 / 60)} 小时${分 % 60 ? ` ${分 % 60} 分钟` : ""}`;
}
