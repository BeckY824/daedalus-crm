-- 团队版项目模式 1b（2026-10-23）：部门、业务角色、「角色 × 范围」配置表、项目进组邀请。
-- 隔离在中继这边做：服务器读不到密文，只能按负责人所在的一级部门放行（lib/sync/scope-policy.ts 范围可读）。
-- 规矩同前：控制面只加表、IF NOT EXISTS、每次启动整个重跑。没有这些行 = 老团队原样（只有一个一级部门时隔离不生效）。

-- 部门树：最多三层（parentId 为空 = 一级部门），层数在代码里管
CREATE TABLE IF NOT EXISTS "SyncDept" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "teamId"    TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "parentId"  TEXT,
  "sort"      INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SyncDept_teamId_idx" ON "SyncDept"("teamId");

-- 成员挂在哪个部门、是哪个业务角色。没有这一行 = 按 SyncMember.role 推（老板 → 总管理、主管 → 销售管理、业务员 → 销售成员）
CREATE TABLE IF NOT EXISTS "SyncMemberRole" (
  "teamId"           TEXT NOT NULL,
  "accountId"        TEXT NOT NULL,
  "deptId"           TEXT,
  -- director 总管理 / admin 管理员 / sales_mgr 销售管理 / sales 销售成员 / channel_ops 渠道运营 / marketing_mgr 市场管理 / project_ops 项目运营
  "bizRole"          TEXT NOT NULL,
  -- 虚线上级：只显示，不给权限（第一版）
  "dottedManagerId"  TEXT,
  "changedAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "by"               TEXT,
  PRIMARY KEY ("teamId", "accountId")
);

-- 「角色 × 范围 / 字段」：没有这一行 = 代码里的默认值（= 现在的行为）
CREATE TABLE IF NOT EXISTS "SyncRoleScope" (
  "teamId"    TEXT NOT NULL,
  "bizRole"   TEXT NOT NULL,
  -- self 本人 / self_share 本人 + 互看开关 / dept 本一级部门 / all 全公司
  "scope"     TEXT NOT NULL,
  -- 字段级权限先只有 all
  "fields"    TEXT NOT NULL DEFAULT 'all',
  "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "by"        TEXT,
  PRIMARY KEY ("teamId", "bizRole")
);

-- 项目进组（通道①：负责人邀请、本人同意才算进组）。同意了的人能读这个项目范围（含子表），不管在哪个部门
CREATE TABLE IF NOT EXISTS "SyncProjectInvite" (
  "teamId"     TEXT NOT NULL,
  -- 项目的范围 id（Project:<k>），和 scope-policy 算范围一致
  "scopeId"    TEXT NOT NULL,
  "accountId"  TEXT NOT NULL,
  -- 组员角色（1a 的四个默认角色之一），中继只存不判
  "groupRole"  TEXT,
  -- pending 等对方同意 / accepted 已进组 / declined 拒了 / removed 移出
  "status"     TEXT NOT NULL DEFAULT 'pending',
  "invitedBy"  TEXT NOT NULL,
  -- 发邀请那台用团队钥匙封好的项目名（中继读不到）：被邀请的人还没拿到项目时靠它显示「谁邀请你进哪个项目」
  "label"      TEXT,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt" DATETIME,
  PRIMARY KEY ("teamId", "scopeId", "accountId")
);
CREATE INDEX IF NOT EXISTS "SyncProjectInvite_member_idx" ON "SyncProjectInvite"("teamId", "accountId");
