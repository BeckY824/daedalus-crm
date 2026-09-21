"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button } from "antd";
import { ExperimentOutlined, PlusOutlined, SnippetsOutlined } from "@ant-design/icons";
import { 查演示数据状态, 灌一套演示数据, type 演示数据状态 } from "@/app/(app)/demo-data";
import { useBusiness } from "@/lib/business-client";

/**
 * 空库时的首页：一句欢迎 + 一张「开始」卡，不摆指标也不摆信号（设计稿 05/HOME·EMPTY）。
 *
 * 第一次打开这套系统的人需要的是一个能点的起点，不是一屏 0 和一个空输入框。
 * 三步横着排，每步只有一个短句——它们是「这一步」的路标，不是说明书；
 * 真正要解释的那句话放在三步下面一行。
 *
 * **一张卡上只有一个主按钮**。网页版上灌演示数据能最快看出它长什么样，所以那里它是主按钮；
 * 桌面端、托管版和非管理员点不到演示数据（见 demo-data.ts 的护栏），那时「新建第一位」
 * 自己升为主按钮——不能出现一张卡上零个主按钮的情况。
 */
export default function StartCard() {
  const b = useBusiness();
  const router = useRouter();
  const { message } = App.useApp();
  const [状态, set状态] = useState<演示数据状态 | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    查演示数据状态().then(set状态).catch(() => {});
  }, []);

  // 状态还没回来时先不画按钮组：画了再换主次，会当着人的面跳一下
  const 能灌演示 = Boolean(状态?.可灌 && 状态.有权限 && 状态.空库);

  /*
    三步的第一步 2026-09-21 从「录一位客户」改成「粘一段聊天」：
    空库的人手上没有数据，让他一个字一个字敲第一位是最慢的一条路，
    而他微信里就有现成的名单。主线是「粘一段 → 客户本自己长出来」。
  */
  const 步骤 = [`粘一段聊天，切成${b.customer}`, "问一句进展", "让它记一笔"];

  return (
    <>
      <h1 className="start-h">欢迎使用 Daedalus CRM</h1>
      <div className="start">
        <span className="start-badge">第 1 步</span>
        <div className="start-t">完成第一次工作流</div>
        <ol className="start-steps">
          {步骤.map((t, i) => (
            <li key={t}>
              <b>{i + 1}</b>
              <span className="start-step-t">{t}</span>
            </li>
          ))}
        </ol>
        {能灌演示 && (
          <p className="start-s">
            也可以一键加入演示{b.customer}、跟进、商机和计划；数据明确标为演示，可随时清除。
          </p>
        )}
        <div className="start-a">
          {能灌演示 && (
            <Button
              type="primary"
              icon={<ExperimentOutlined />}
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await 灌一套演示数据();
                  if (!r.ok) return void message.error(r.error);
                  message.success("演示数据已灌入，可以随便点");
                  router.refresh();
                })
              }
            >
              灌一套演示数据
            </Button>
          )}
          {/* 主按钮是「粘」：它比手敲快一个量级，而这一屏的人手上多半有一段微信记录 */}
          <Button
            type={能灌演示 ? "default" : "primary"}
            icon={<SnippetsOutlined />}
            onClick={() => router.push("/customers?import=paste")}
          >
            粘一段聊天
          </Button>
          <Button icon={<PlusOutlined />} onClick={() => router.push("/customers?new=1")}>
            手动录一位
          </Button>
        </div>
        {能灌演示 && <p className="start-note">不会覆盖已有业务数据</p>}
      </div>
    </>
  );
}
