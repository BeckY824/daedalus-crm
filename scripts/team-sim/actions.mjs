/**
 * 团队版五台实测要调的 Server Action：「源文件#导出名」（2026-10-04，上线前测试 4.1）。
 * 单独放一个文件，是为了让 tests/team-sim-actions.test.ts 在平常的 vitest 里就钉住它们——
 * 哪个动作改了名、挪了文件，不用等谁去跑一遍 npm run test:team 才发现脚本坏了。
 */
export const 动作 = {
  选模版: "src/app/start/actions.ts#选模版",
  录客户: "src/app/(app)/customers/actions.ts#saveCustomer",
  改一格: "src/app/(app)/customers/actions.ts#patchCustomer",
  记跟进: "src/app/(app)/customers/[id]/actions.ts#saveFollowUp",
  放进公海: "src/app/(app)/customers/pool-actions.ts#放进公海",
  领取: "src/app/(app)/customers/pool-actions.ts#领取",
  建团队: "src/app/(app)/settings/team-actions.ts#建团队动作",
  加入团队: "src/app/(app)/settings/team-actions.ts#加入团队动作",
  团队状态: "src/app/(app)/settings/team-actions.ts#读团队状态",
  移除成员: "src/app/(app)/settings/team-actions.ts#移除成员动作",
  开通团队: "src/app/admin/actions.ts#setSyncTeam",
};
