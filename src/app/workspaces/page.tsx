import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { accessibleWorkspacesFor } from "@/lib/tenant/workspace-access";
import AuthSide from "../login/AuthSide";
import WorkspacePicker from "./WorkspacePicker";
export const dynamic = "force-dynamic";
export default async function WorkspacesPage() {
  const me = await requireUser();
  if (!me.accountId || !me.workspaceId) redirect("/start");
  const list = await accessibleWorkspacesFor(me.accountId);
  return <div className="auth"><AuthSide /><main className="auth-main"><WorkspacePicker list={list} current={me.workspaceId} /></main></div>;
}
