import SettingsModal from "@/components/SettingsModal";
import SettingsBody from "../../settings/SettingsBody";

/**
 * 应用内点「设置」时走这条：地址还是 /settings，但画出来的是盖在当前页上的一层浮层。
 * 刷新或者直接敲地址不会走这里（那是硬导航），落到的是 settings/page.tsx 那份整页。
 * 正文两边共用 SettingsBody——取数只有一份，不会出现「浮层里是新的、整页里是旧的」。
 */
export const dynamic = "force-dynamic";

export default function 设置浮层() {
  return (
    <SettingsModal>
      <SettingsBody />
    </SettingsModal>
  );
}
