import type { Prisma } from "@/generated/prisma";
import { scheduleValue } from "@/lib/schedule-date";
import type { FollowUpRow } from "./types";

export const followHistoryInclude = {
  owner: { select: { name: true } },
  contact: { select: { name: true, position: true } },
  source: { select: { text: true } },
  opportunity: { select: { id: true, name: true, customerId: true } },
  orderNode: { select: { order: { select: { id: true, no: true } } } },
} satisfies Prisma.FollowUpInclude;
export const followHistoryOrder = [{ occurredAt: "desc" }, { id: "desc" }] satisfies Prisma.FollowUpOrderByWithRelationInput[];

export function serializeFollowHistory(f: Prisma.FollowUpGetPayload<{ include: typeof followHistoryInclude }>): FollowUpRow {
  return {
    id: f.id, type: f.type, title: f.title, content: f.content, status: f.status, duration: f.duration,
    occurredAt: f.occurredAt.toISOString(), dueAt: scheduleValue(f.dueAt, f.dueOn), dueHasTime: f.dueHasTime,
    participants: f.participants, sourceText: f.source?.text ?? null, ownerId: f.ownerId, ownerName: f.owner.name,
    contactName: f.contact?.name ?? null, contactPosition: f.contact?.position ?? null, contactId: f.contactId,
    opportunityId: f.opportunityId,
    opportunity: f.opportunity?.customerId === f.customerId ? { id: f.opportunity.id, name: f.opportunity.name } : null,
    orderId: f.orderNode?.order.id ?? null, order: f.orderNode?.order ?? null,
    updatedAt: f.updatedAt.toISOString(),
  };
}
