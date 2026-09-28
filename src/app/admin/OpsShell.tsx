"use client";

import { useTransition } from "react";
import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import {
  AppstoreOutlined,
  DashboardOutlined,
  MessageOutlined,
  ReloadOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { dayjs } from "@/lib/utils";

export type 页 = "总览" | "用户" | "工作区" | "模型用量" | "反馈";

const 导航: { 组: string; 项: { 名: 页; 去: string; icon: React.ReactNode }[] }[] = [
  {
    组: "监控",
    项: [
      { 名: "总览", 去: "", icon: <DashboardOutlined /> },
      { 名: "用户", 去: "/users", icon: <TeamOutlined /> },
      { 名: "模型用量", 去: "/usage", icon: <ThunderboltOutlined /> },
    ],
  },
  {
    组: "运营",
    项: [
      { 名: "工作区", 去: "/workspaces", icon: <AppstoreOutlined /> },
      { 名: "反馈", 去: "/feedback", icon: <MessageOutlined /> },
    ],
  },
];

/** 运营台里的站内链接：走口令进来的，口令要跟着走；走运营台票进来的（桌面端），网址上什么都不带 */
export const 站内 = (token: string, 路径: string) => (token ? `/admin${路径}?token=${encodeURIComponent(token)}` : `/admin${路径}`);

/**
 * 「点了，还在等」的记号。2026-09-28 用户说运营台点起来好卡：服务器渲染一页 50–200 ms，
 * 慢的是到香港那一趟（首字节 1.3–1.8 s），而点下去之后页面纹丝不动，像没点上。
 *
 * 不能用 loading.tsx 解决：外壳要等验完口令才画（见 layout.tsx），骨架屏会先于验证露出来，
 * 而且流式一开始，口令不对就回不了 404 了。所以两手：
 *   - 导航整页预取（prefetch={true}）：进了任一页，其余几页在后台取好，点了就换
 *   - 没取好时当场给反馈：哪里在等，就在那里放一个 .opx-pending，
 *     样式用 :has() 从外面认——导航那一项先亮、正文先暗、指针转圈（ops.css）
 */
export const 等待中 = () => <span className="opx-pending" hidden />;

/** 放在 <Link> 里面：这个链接点了还没到，就挂上记号 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return pending ? <等待中 /> : null;
}

/** 整页预取一个运营台地址（用户列表悬停时用）。PrefetchKind 没公开导出，它的值就是这个字符串 */
export const 预取 = (router: ReturnType<typeof useRouter>, href: string) =>
  router.prefetch(href, { kind: "full" } as Parameters<typeof router.prefetch>[1]);

/**
 * 运营台的外壳：左边一条导航，右边正文。每一页验完口令再画它（见 layout.tsx 那段为什么）。
 *
 * 左下角写清数据截至什么时候：这几页是快照，不会自己刷新——
 * 不写的话，看的人会拿半小时前的数做决定。旁边一颗「刷新」，不用整页重载。
 */
export default function OpsShell({
  当前,
  token,
  环境,
  渲染于,
  反馈没处理,
  children,
}: {
  当前: 页;
  token: string;
  环境: "生产" | "本地";
  渲染于: string;
  反馈没处理: number;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [刷新中, 开始] = useTransition();
  return (
    <div className="opx">
      <aside className="opx-side">
        <div className="opx-brand">
          <span className="opx-logo" aria-hidden>
            D
          </span>
          <div>
            <b>Daedalus Ops</b>
            <small>运营台</small>
          </div>
          <span className={`opx-env${环境 === "生产" ? " opx-env-live" : ""}`}>{环境 === "生产" ? "PRODUCTION" : "本地"}</span>
        </div>
        <nav className="opx-nav" aria-label="运营台导航">
          {导航.map((g) => (
            <div key={g.组}>
              <div className="opx-nav-h">{g.组}</div>
              {g.项.map((x) => (
                <Link
                  key={x.名}
                  href={站内(token, x.去)}
                  prefetch
                  className={当前 === x.名 ? "on" : undefined}
                  aria-current={当前 === x.名 ? "page" : undefined}
                >
                  <LinkPending />
                  {x.icon}
                  <span>{x.名}</span>
                  {x.名 === "反馈" && 反馈没处理 > 0 && (
                    <span className="opx-nav-n" aria-label={`${反馈没处理} 条没处理`}>
                      {反馈没处理}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="opx-side-foot">
          数据截至 {dayjs(渲染于).format("MM-DD HH:mm")}
          <br />
          <button type="button" onClick={() => 开始(() => router.refresh())} disabled={刷新中}>
            {刷新中 && <等待中 />}
            <ReloadOutlined spin={刷新中} /> {刷新中 ? "刷新中…" : "刷新"}
          </button>
        </div>
      </aside>
      <main className="opx-main">{children}</main>
    </div>
  );
}

/** 每一页的标题行：大标题、一句口径、右边放这一页的动作 */
export function 页头({ 标题, 说明, 面包屑, 右 }: { 标题: React.ReactNode; 说明?: React.ReactNode; 面包屑?: React.ReactNode; 右?: React.ReactNode }) {
  return (
    <header className="opx-head">
      <div style={{ minWidth: 0 }}>
        {面包屑 && <div className="opx-crumb">{面包屑}</div>}
        <h1>{标题}</h1>
        {说明 && <p>{说明}</p>}
      </div>
      {右 && <div className="opx-head-r">{右}</div>}
    </header>
  );
}
