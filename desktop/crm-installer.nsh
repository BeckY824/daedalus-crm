; G2: validate the final installation directory BEFORE uninstallOldVersion.
; Works for /S /D=... and the directory selected in the assisted installer.
!ifndef BUILD_UNINSTALLER
Function crmCheckInstallTarget
  Push $0
  Push $1
  StrCpy $0 ""
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors crm_target_failed
  GetTempFileName $0 "$INSTDIR"
  IfErrors crm_target_failed
  FileOpen $1 "$0" w
  IfErrors crm_target_cleanup
  FileWrite $1 "Daedalus CRM install target write check"
  IfErrors crm_target_close_failed
  FileClose $1
  IfErrors crm_target_cleanup
  Delete "$0"
  IfErrors crm_target_failed
  Pop $1
  Pop $0
  Return

crm_target_close_failed:
  FileClose $1
crm_target_cleanup:
  Delete "$0"
crm_target_failed:
  DetailPrint "Cannot write installation directory: $INSTDIR. The existing installation was not removed."
  IfSilent +2
  MessageBox MB_OK|MB_ICONSTOP "无法写入安装目录：$INSTDIR。原有程序尚未卸载。请选择当前用户可写的目录，或用管理员权限重新安装。"
  Pop $1
  Pop $0
  SetErrorLevel 5
  Quit
FunctionEnd
!endif

!macro crmCheckInstallTarget
  Call crmCheckInstallTarget
!macroend
