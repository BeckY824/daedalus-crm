"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button } from "antd";
import { ExperimentOutlined, ImportOutlined, PlusOutlined, SettingOutlined, SnippetsOutlined, TeamOutlined } from "@ant-design/icons";
import { 查演示数据状态, 灌一套演示数据, type 演示数据状态 } from "@/app/(app)/demo-data";
import { useBusiness } from "@/lib/business-client";
import { 外贸精简 } from "@/lib/business-config";

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
 * 企业版的管理员例外：那边没有演示数据，主按钮是「导入」（去设置 → 企业版导入），见 去导入。
 */
export default function StartCard({ 自己服务器 = false, 去导入 = false, 企业版 = false }: {
  /**
   * 跑在客户自己部署的服务器上（企业版私有部署、自部署的网页版，2026-10-25）：
   * 第三句不能再说「数据只在你的电脑上」「账号用来记 AI 次数和团队版同步」——
   * 那是桌面端的话，企业版没有我们的云端账号、AI 也不计次。page.tsx 按 !本地模式() && !multiTenant() 传
   */
  自己服务器?: boolean;
  /**
   * 企业版（CRM_ENTERPRISE=1）的管理员（2026-10-25 总控定）：主按钮换成「导入」，去设置里的企业版导入。
   * 企业版是客户的正式库，演示数据接口直接拒绝（demo-data.ts），空库的第一步就是把真实数据导进来。
   * page.tsx 按 企业版() && 管理员 传；和设置页那一栏出现的条件一致
   */
  去导入?: boolean;
  /**
   * 企业版（CRM_ENTERPRISE=1，2026-10-26 验收 #8）：不弹个人版那套「粘一段聊天 → AI 切客户」的引导，
   * 换成项目那条线——管理员先导入、建组织和成员、设项目规则；成员从新建项目开始。page.tsx 按 企业版() 传
   */
  企业版?: boolean;
} = {}) {
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

  if (企业版) return <企业版开始 b={b} 管理员={去导入} 去={(u) => router.push(u)} />;

  return (
    <>
      <h1 className="start-h">欢迎使用 Daedalus CRM</h1>
      {/*
        三句介绍（2026-10-02，原型第二页「先放点客户进来」那张清单改成的）：
        第一次进来的人先知道这东西能替他做什么，再看下面那张卡从哪儿开始。
        不做成单独一页、不要勾选和进度条——三件事的入口左栏本来就有，再摆一份清单是重复。
      */}
      <ul className="start-intro">
        <li>
          <b>{b.customer}本自己长出来</b>
          <span>粘一段{外贸精简(b) ? "WhatsApp 或微信" : "微信"}聊天、拖进一张 Excel，AI 切成一位位{b.customer}。</span>
        </li>
        <li>
          <b>AI 帮你盯跟进</b>
          <span>谁该联系了、上次聊到哪、下一句怎么说，问一句就知道。</span>
        </li>
        {自己服务器 ? (
          <li>
            <b>数据在你们自己的服务器上</b>
            <span>{b.customer}资料存在部署这套系统的服务器上，用 AI 时只把你让它看的那一段发给服务器上配好的模型。</span>
          </li>
        ) : (
          <li>
            <b>数据只在你的电脑上</b>
            <span>账号用来记 AI 次数和团队版同步。{b.customer}资料存在这台电脑上，用 AI 时只发你让它看的那一段；开了团队同步才加密经过云端。</span>
          </li>
        )}
      </ul>
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
          {去导入 && (
            <Button type="primary" icon={<ImportOutlined />} onClick={() => router.push("/settings?tab=enterprise")}>
              导入{b.customer}数据
            </Button>
          )}
          {/* 主按钮是「粘」：它比手敲快一个量级，而这一屏的人手上多半有一段微信记录 */}
          <Button
            type={能灌演示 || 去导入 ? "default" : "primary"}
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

/** 企业版空库首页：项目从建档到推进一条线，不提演示数据和粘聊天（验收 #8） */
function 企业版开始({ b, 管理员, 去 }: { b: ReturnType<typeof useBusiness>; 管理员: boolean; 去: (url: string) => void }) {
  const 步骤 = 管理员 ? [`导入${b.customer}数据`, "建组织和成员", "设好项目规则"] : ["新建第一个项目", "记一次沟通", "按节点往前推"];
  return (
    <>
      <h1 className="start-h">欢迎使用 Daedalus CRM</h1>
      <ul className="start-intro">
        <li>
          <b>项目一条线走到底</b>
          <span>从线索、建档、推进到交付，每个节点谁负责、下一步什么时候，都记在项目上。</span>
        </li>
        <li>
          <b>公海和超时回收自动管</b>
          <span>超过处理时长没跟进的项目回到公海，别人可以领；负责人随时看得到。</span>
        </li>
        <li>
          <b>数据在你们自己的服务器上</b>
          <span>{b.customer}和项目资料存在部署这套系统的服务器上，用 AI 时只把你让它看的那一段发给服务器上配好的模型。</span>
        </li>
      </ul>
      <div className="start">
        <span className="start-badge">第 1 步</span>
        <div className="start-t">{管理员 ? "把团队搭起来" : "建你的第一个项目"}</div>
        <ol className="start-steps">
          {步骤.map((t, i) => (
            <li key={t}>
              <b>{i + 1}</b>
              <span className="start-step-t">{t}</span>
            </li>
          ))}
        </ol>
        <div className="start-a">
          {管理员 ? (
            <>
              <Button type="primary" icon={<ImportOutlined />} onClick={() => 去("/settings?tab=enterprise")}>
                导入{b.customer}数据
              </Button>
              <Button icon={<TeamOutlined />} onClick={() => 去("/settings?tab=org")}>
                组织架构
              </Button>
              <Button icon={<SettingOutlined />} onClick={() => 去("/settings?tab=project")}>
                项目规则
              </Button>
            </>
          ) : (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => 去("/projects/new")}>
              新建项目
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
