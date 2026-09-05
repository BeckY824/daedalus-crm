"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Row, Col, Segmented, Empty, Checkbox, Tag, Space, Button, App, Typography } from "antd";
import { CarryOutOutlined, CheckCircleOutlined, CalendarOutlined } from "@ant-design/icons";
import { PageHead, CompanyLogo, UserCell } from "@/components/ui";
import { dayjs, smartTime, fmtDateTime } from "@/lib/utils";
import { toggleTask } from "../../customers/[id]/actions";
import { completePlan } from "../../customers/[id]/actions";

type Plan = {
  id: string;
  subject: string;
  plannedAt: string;
  method: string;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

type Task = {
  id: string;
  title: string;
  dueAt: string | null;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

export default function PlansView({
  plans,
  tasks,
  meId,
}: {
  plans: Plan[];
  tasks: Task[];
  meId: string;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [scope, setScope] = useState<string | number>("我的");
  const [when, setWhen] = useState<string | number>("全部");

  function inWindow(d: string | null) {
    if (!d) return when === "全部";
    const t = dayjs(d);
    if (when === "逾期") return t.isBefore(dayjs());
    if (when === "今天") return t.isSame(dayjs(), "day");
    if (when === "本周") return t.isBefore(dayjs().endOf("week")) && t.isAfter(dayjs().startOf("day"));
    return true;
  }

  const myPlans = useMemo(
    () => plans.filter((p) => (scope === "我的" ? p.ownerId === meId : true)).filter((p) => inWindow(p.plannedAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plans, scope, when, meId],
  );

  const myTasks = useMemo(
    () => tasks.filter((t) => (scope === "我的" ? t.ownerId === meId : true)).filter((t) => inWindow(t.dueAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, scope, when, meId],
  );

  const overdue = (d: string | null) => d && dayjs(d).isBefore(dayjs());

  return (
    <>
      <PageHead
        icon={<CalendarOutlined />}
        title="跟进计划"
        subtitle="任务与提醒，客户推进有节奏"
        tag="跟进管理"
        tagNote="计划先行，跟进不遗漏"
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Segmented value={scope} onChange={setScope} options={["我的", "全部成员"]} />
        <Segmented value={when} onChange={setWhen} options={["全部", "逾期", "今天", "本周"]} />
      </Space>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space size={8}>
                <CarryOutOutlined style={{ color: "#f59e0b" }} />
                <span className="section-title">待办任务（{myTasks.length}）</span>
              </Space>
            }
            styles={{ body: { paddingTop: 8 } }}
          >
            {myTasks.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待办任务" />}
            {myTasks.map((t) => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px dashed #eef2f7" }}>
                <Checkbox
                  onChange={async (e) => {
                    if (!e.target.checked) return;
                    await toggleTask(t.id, true);
                    message.success("任务已完成");
                    router.refresh();
                  }}
                />
                <CompanyLogo name={t.customerName} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{t.title}</div>
                  <a href={`/customers/${t.customerId}`} style={{ fontSize: 12, color: "#94a3b8" }}>
                    {t.customerName}
                  </a>
                </div>
                <Space size={8}>
                  {overdue(t.dueAt) && <Tag color="error" style={{ margin: 0, borderRadius: 6 }}>逾期</Tag>}
                  <span style={{ fontSize: 12, color: overdue(t.dueAt) ? "#dc2626" : "#64748b" }}>{smartTime(t.dueAt)}</span>
                  {scope === "全部成员" && <UserCell name={t.ownerName} size={22} />}
                </Space>
              </div>
            ))}
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card
            title={
              <Space size={8}>
                <CalendarOutlined style={{ color: "#1668dc" }} />
                <span className="section-title">跟进计划（{myPlans.length}）</span>
              </Space>
            }
            styles={{ body: { paddingTop: 8 } }}
          >
            {myPlans.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待执行的跟进计划" />}
            {myPlans.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px dashed #eef2f7" }}>
                <CompanyLogo name={p.customerName} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{p.subject}</div>
                  <Space size={6}>
                    <a href={`/customers/${p.customerId}`} style={{ fontSize: 12, color: "#94a3b8" }}>
                      {p.customerName}
                    </a>
                    <Tag style={{ margin: 0, borderRadius: 6, fontSize: 11 }}>{p.method}</Tag>
                  </Space>
                </div>
                <Space size={8}>
                  {overdue(p.plannedAt) && <Tag color="error" style={{ margin: 0, borderRadius: 6 }}>逾期</Tag>}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {fmtDateTime(p.plannedAt)}
                  </Typography.Text>
                  <Button
                    type="text"
                    size="small"
                    icon={<CheckCircleOutlined style={{ color: "#16a34a" }} />}
                    onClick={async () => {
                      await completePlan(p.id);
                      message.success("计划已完成");
                      router.refresh();
                    }}
                  />
                </Space>
              </div>
            ))}
          </Card>
        </Col>
      </Row>
    </>
  );
}
