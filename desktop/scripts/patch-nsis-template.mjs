/** Backport the upstream per-user known-folder crash fix without upgrading the
 * packaging dependency tree. electron-builder #7921 reports System::Store
 * access violations; upstream multiUser.nsh now uses bounded lstrcpynW instead.
 * https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/multiUser.nsh
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const oldBlock = `      System::Store S
      # Win7 has a per-user programfiles known folder and this can be a non-default location
      System::Call 'SHELL32::SHGetKnownFolderPath(g "\u0024{FOLDERID_UserProgramFiles}", i \u0024{KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
      \u0024{If} $1 == 0
        System::Call '*$2(&w\u0024{NSIS_MAX_STRLEN} .s)'
        StrCpy $0 $1
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      \u0024{endif}
      System::Store L`;
const fixedBlock = `      Push $1
      Push $2
      # Bound the copy to the actual allocated known-folder string.
      StrCpy $2 0
      System::Call 'SHELL32::SHGetKnownFolderPath(g "\u0024{FOLDERID_UserProgramFiles}", i \u0024{KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
      \u0024{If} $1 == 0
        System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i \u0024{NSIS_MAX_STRLEN})p'
      \u0024{endif}
      \u0024{If} $2 != 0
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      \u0024{endif}
      Pop $2
      Pop $1`;

export function patchTemplate(file) {
  const text = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  if (text.includes(fixedBlock) && !text.includes(oldBlock)) return false;
  if (text.split(oldBlock).length !== 2) throw new Error("Unknown NSIS template: review upstream before packaging");
  fs.writeFileSync(file, text.replace(oldBlock, fixedBlock));
  return true;
}

// electron-builder 没有卸载旧版前的安装目标校验钩子；customInstall 已经太晚。
export function patchInstallSection(file) {
  const text = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const before = "!include installer.nsh\n";
  const after = before + "\n# Check the final /D or UI target before closing or uninstalling the usable app.\n!insertmacro crmCheckInstallTarget\n";
  if (text.includes(after)) return false;
  if (text.split(before).length !== 2 || !text.includes("!insertmacro uninstallOldVersion SHELL_CONTEXT")) throw new Error("Unknown NSIS install section: review upstream before packaging");
  fs.writeFileSync(file, text.replace(before, after));
  return true;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const directory = path.dirname(require.resolve("app-builder-lib/package.json"));
  const file = path.join(directory, "templates/nsis/multiUser.nsh");
  console.log(patchTemplate(file) ? "NSIS per-user known-folder fix applied" : "NSIS per-user known-folder fix already applied");
  console.log(patchInstallSection(path.join(directory, "templates/nsis/installSection.nsh")) ? "NSIS install target preflight applied" : "NSIS install target preflight already applied");
}
