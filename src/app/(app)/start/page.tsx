import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { 要选模版 } from "@/lib/onboarding";
import TemplatePicker from "./TemplatePicker";

/** 新用户第一次进来先选模版。不该选（老用户、网页版、选过了）就直接去首页 */
export default async function StartPage() {
  await requireUser();
  if (!(await 要选模版())) redirect("/dashboard");
  return <TemplatePicker />;
}
