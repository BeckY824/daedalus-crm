"use client";

import { useRouter } from "next/navigation";
import { App, Col, Form, Input, Modal, Row, Segmented } from "antd";
import { 聚焦首项 } from "@/lib/modal-focus";
import { 评级们 } from "@/lib/supplier";
import { saveSupplier, type 供应商输入 } from "./actions";

/**
 * 供应商档案（2026-10-03 外贸第 3c 块）。「出过的问题」放得靠前、给得宽：
 * 延期、质量、包装错——下次选厂前扫一眼，比 A / B / C 的评级有用（外贸CRM模版.md 3.2）。
 */
export default function SupplierForm({ open, editing, onClose }: { open: boolean; editing?: (供应商输入 & { id: string }) | null; onClose: (存了: boolean, id?: string) => void }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm();

  async function onOk() {
    const v = await form.validateFields();
    const r = await saveSupplier({ ...v, id: editing?.id, rating: v.rating || null });
    if (!r.ok) return message.error(r.error);
    message.success(editing ? "已保存" : "供应商已建好");
    onClose(true, r.id);
    router.refresh();
  }

  return (
    <Modal open={open} title={editing ? "编辑供应商" : "新建供应商"} onCancel={() => onClose(false)} onOk={onOk} okText="保存" cancelText="取消" width={640} afterOpenChange={聚焦首项} destroyOnHidden>
      <Form form={form} layout="vertical" style={{ marginTop: 8 }} initialValues={editing ?? {}}>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, message: "请填供应商名称" }]}>
              <Input maxLength={60} placeholder="如：中山明亮灯饰厂" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="category" label="主营品类"><Input maxLength={60} placeholder="如：LED 面板灯" /></Form.Item>
          </Col>
          <Col span={8}><Form.Item name="region" label="地区"><Input maxLength={60} placeholder="如：中山古镇" /></Form.Item></Col>
          <Col span={8}><Form.Item name="contact" label="联系人"><Input maxLength={40} /></Form.Item></Col>
          <Col span={8}><Form.Item name="phone" label="电话"><Input maxLength={40} /></Form.Item></Col>
          <Col span={8}><Form.Item name="wechat" label="微信"><Input maxLength={60} /></Form.Item></Col>
          <Col span={8}><Form.Item name="invoice" label="开票"><Input maxLength={40} placeholder="如：能开 13% 专票" /></Form.Item></Col>
          <Col span={8}><Form.Item name="payment" label="付款方式"><Input maxLength={60} placeholder="如：30% 定金 / 货好付清" /></Form.Item></Col>
          <Col span={24}>
            <Form.Item name="rating" label="评级">
              <Segmented options={[{ value: "", label: "未评" }, ...评级们]} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="issues" label="出过的问题" extra="延期、质量、包装错……下次选厂前扫一眼，比评级有用">
              <Input.TextArea rows={3} maxLength={2000} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="remark" label="备注"><Input.TextArea rows={2} maxLength={2000} /></Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
