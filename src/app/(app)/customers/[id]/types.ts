import type { 可选成员 } from "@/lib/utils";
import type { ContractRow } from "./ContractForm";
import type { CustomerRow } from "../CustomerForm";

export type FollowUpRow = {
  id: string;
  type: string;
  title: string;
  content: string;
  status: string;
  duration: number | null;
  occurredAt: string;
  dueAt: string | null;
  attachment: string | null;
  attachSize: string | null;
  participants: string | null;
  /** 速记解析时的原始聊天记录，只有 AI 起草过的记录才有 */
  sourceText: string | null;
  ownerName: string;
  contactName: string | null;
  contactPosition: string | null;
  contactId: string | null;
  opportunityId: string | null;
};

export type ContactRow = {
  id: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  wechat: string | null;
  isPrimary: boolean;
  remark: string | null;
};

export type RecordProps = {
  customer: CustomerRow;
  contacts: ContactRow[];
  opportunities: {
    id: string;
    name: string;
    amount: number;
    stage: string;
    status: string;
    probability: number;
    expectedDealAt: string | null;
  }[];
  contracts: ContractRow[];
  tasks: { id: string; title: string; dueAt: string | null; done: boolean }[];
  plan: { id: string; subject: string; plannedAt: string; method: string } | null;
  followUps: FollowUpRow[];
  users: 可选成员[];
  channels: { id: string; name: string }[];
  /** 可作为推荐人的已有学员 */
  referrableCustomers: { id: string; name: string }[];
  stats: { followCount: number; callSeconds: number; meetingCount: number; emailCount: number };
  /** 服务端是否配置了 AI。没配时 AI 面板整体不渲染 */
  aiEnabled: boolean;
};
