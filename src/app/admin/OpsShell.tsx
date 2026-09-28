"use client";

import Link from "next/link";
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

/** 运营台里的站内链接：口令要跟着走（它就在网址上，这一页才进得来） */
export const 站内 = (token: string, 路径: string) => `/admin${路径}?token=${encodeURIComponent(token)}`;

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
                <Link key={x.名} href={站内(token, x.去)} className={当前 === x.名 ? "on" : undefined} aria-current={当前 === x.名 ? "page" : undefined}>
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
          <button type="button" onClick={() => router.refresh()}>
            <ReloadOutlined /> 刷新
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
