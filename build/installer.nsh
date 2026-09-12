!include "nsDialogs.nsh"
!include "LogicLib.nsh"

# Crisp text on high-DPI displays: the stock manifest is DPI-unaware, so
# Windows bitmap-scales the installer and everything looks blurry.
ManifestDPIAware true

# The uninstaller-only compile pass emits an empty install section, which
# leaves every function/var here unreferenced and -WX fails the build on the
# warning. Compile the options page only for the installer pass.
!ifndef BUILD_UNINSTALLER

Var AutobrightDesktop
Var AutobrightAutostart
Var AutobrightTaskbar
Var AutobrightValDesktop
Var AutobrightValAutostart
Var AutobrightValTaskbar

!macro customPageAfterChangeDir
  Page custom AutobrightOptionsPagePre AutobrightOptionsPageLeave
!macroend

Function AutobrightOptionsPagePre
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "Additional tasks:"
  Pop $0

  ${NSD_CreateCheckbox} 8u 24u 90% 12u "Create a &desktop shortcut"
  Pop $AutobrightDesktop
  ${NSD_Check} $AutobrightDesktop

  ${NSD_CreateCheckbox} 8u 40u 90% 12u "Pin to &taskbar"
  Pop $AutobrightTaskbar
  ${NSD_Check} $AutobrightTaskbar

  ${NSD_CreateCheckbox} 8u 56u 90% 12u "Start &LuxLearn with Windows"
  Pop $AutobrightAutostart
  ${NSD_Check} $AutobrightAutostart

  nsDialogs::Show
FunctionEnd

Function AutobrightOptionsPageLeave
  ${NSD_GetState} $AutobrightDesktop $AutobrightValDesktop
  ${NSD_GetState} $AutobrightAutostart $AutobrightValAutostart
  ${NSD_GetState} $AutobrightTaskbar $AutobrightValTaskbar
FunctionEnd

!macro customInstall
  ${If} $AutobrightValDesktop == ${BST_UNCHECKED}
    Delete "$newDesktopLink"
  ${EndIf}

  # Taskbar pinning is deliberately user-initiated on modern Windows:
  # the "pin to taskbar" shell verb rejects non-explorer callers since
  # 1809, and copying .lnk files into User Pinned no longer sticks — the
  # old StdUtils InvokeShellVerb call here silently did nothing. The
  # checkbox now records intent in the registry; on next start the app
  # shows a one-time toast telling the user how to pin the running icon.
  ${If} $AutobrightValTaskbar == ${BST_CHECKED}
    WriteRegStr SHELL_CONTEXT "Software\${PRODUCT_NAME}" "PinToTaskbarRequested" "1"
  ${Else}
    DeleteRegValue SHELL_CONTEXT "Software\${PRODUCT_NAME}" "PinToTaskbarRequested"
  ${EndIf}

  # Old app builds registered startup under the AUMID name instead of
  # ${PRODUCT_NAME}, which duplicated the entry on every update.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SKR.LuxLearn"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SKR.AutoBright"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "SKR.LuxLearn"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "SKR.AutoBright"

  ${If} $AutobrightValAutostart == ${BST_CHECKED}
    WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}" '"$appExe" --hidden'
  ${Else}
    DeleteRegValue SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  ${EndIf}
!macroend

!endif # BUILD_UNINSTALLER

# Runs in the uninstaller pass, so it must live outside the guard above.
!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCT_NAME}"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartAppCustom"
  Function StartAppCustom
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !insertmacro MUI_PAGE_FINISH
!macroend
