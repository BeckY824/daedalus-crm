import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export default async function RootPage() {
  const user = await getCurrentUser();
  // 登录了先过选模版那一页：新用户在那儿选，其余的它直接送去首页
  redirect(user ? "/start" : "/login");
}
