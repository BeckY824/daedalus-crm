import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
// The packaging script also runs directly under Node on Windows.
import { patchTemplate, patchInstallSection } from "../desktop/scripts/patch-nsis-template.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temporary(text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-nsis-template-")); roots.push(root);
  const file = path.join(root, "multiUser.nsh"); fs.writeFileSync(file, text); return file;
}
it("backports the bounded known-folder copy and preserves registry and directory overrides", () => {
  const require = createRequire(path.resolve("desktop/package.json"));
  const template = path.join(path.dirname(require.resolve("app-builder-lib/package.json")), "templates/nsis/multiUser.nsh");
  const file = temporary(fs.readFileSync(template, "utf8"));
  patchTemplate(file);
  const result = fs.readFileSync(file, "utf8");
  expect(result).toContain("KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p");
  expect(result).not.toContain("System::Store");
  expect(result).not.toContain("*$2(&w${NSIS_MAX_STRLEN} .s)");
  expect(result).toContain('ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation');
  expect(result).toContain('${StdUtils.GetParameter} $R0 "D" ""');
  expect(patchTemplate(file)).toBe(false);
});
it("refuses unknown templates without changing them", () => {
  const file = temporary("unexpected upstream template");
  expect(() => patchTemplate(file)).toThrow("Unknown NSIS template");
  expect(fs.readFileSync(file, "utf8")).toBe("unexpected upstream template");
});

it("G2 preflight runs before closing/uninstalling the old app, for UI and silent installers", () => {
  const require = createRequire(path.resolve("desktop/package.json"));
  const template = path.join(path.dirname(require.resolve("app-builder-lib/package.json")), "templates/nsis/installSection.nsh");
  const file = temporary(fs.readFileSync(template, "utf8"));
  patchInstallSection(file);
  const result = fs.readFileSync(file, "utf8");
  expect(result.indexOf("!insertmacro crmCheckInstallTarget")).toBeLessThan(result.indexOf("!insertmacro CHECK_APP_RUNNING"));
  expect(result.indexOf("!insertmacro crmCheckInstallTarget")).toBeLessThan(result.indexOf("!insertmacro uninstallOldVersion"));
  expect(patchInstallSection(file)).toBe(false);
  const config = JSON.parse(fs.readFileSync(path.resolve("desktop/package.json"), "utf8"));
  const guard = fs.readFileSync(path.resolve("desktop", config.build.nsis.include), "utf8");
  expect(guard).toContain('GetTempFileName $0 "$INSTDIR"');
  expect(guard).toContain('FileOpen $1 "$0" w');
  expect(guard).toMatch(/SetErrorLevel 5\r?\n\s+Quit/);
  expect(guard).not.toContain("WriteReg");
  expect(guard).not.toContain("!insertmacro uninstallOldVersion");
});

it("does not patch an unknown install section", () => {
  const file = temporary("unknown");
  expect(() => patchInstallSection(file)).toThrow("Unknown NSIS install section");
  expect(fs.readFileSync(file, "utf8")).toBe("unknown");
});
