; Replace only the assisted directory page. Keep electron-builder's install
; section, registry layout and UAC broker, including current-user installs.
!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh
!include FileFunc.nsh
!include UAC.nsh
!include StrContains.nsh

Var jokoDirectoryElevation
Var jokoRequestedDirectory
Var jokoRequestedMode
Var jokoRequestedUserSid
Var jokoUserSid
Var jokoDirectoryError
Var jokoDirectoryMessage

!define JOKO_ELEVATION_DIFFERENT_USER 49617

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE JokoDirectoryPre
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE JokoDirectoryLeave
  !insertmacro MUI_PAGE_DIRECTORY
  !define MUI_PAGE_CUSTOMFUNCTION_PRE JokoDirectoryBeforeInstall
  ; Preserve the stock shortcut policy. Define AFTER the stock page branch,
  ; otherwise electron-builder would insert a second directory page.
  !define allowToChangeInstallationDirectory
!macroend

!macro jokoDirectoryInit
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_GetGlobalVar $jokoDirectoryElevation
    ${If} $jokoDirectoryElevation == "1"
      !insertmacro UAC_AsUser_GetGlobalVar $jokoRequestedDirectory
      !insertmacro UAC_AsUser_GetGlobalVar $jokoRequestedMode
      !insertmacro UAC_AsUser_GetGlobalVar $jokoRequestedUserSid
      ; Other-account elevation must not put a current-user install into the
      ; administrator's HKCU/profile. Compare OS identities, not account names.
      ${If} $jokoRequestedMode == "CurrentUser"
        Call JokoGetUserSid
        ${If} $jokoUserSid == ""
        ${OrIf} $jokoUserSid != $jokoRequestedUserSid
          SetErrorLevel ${JOKO_ELEVATION_DIFFERENT_USER}
          Quit
        ${EndIf}
      ${EndIf}
      Call JokoRestoreDirectory
    ${EndIf}
  ${EndIf}
  ; Silent installs skip page callbacks. Check before uninstalling an old
  ; version, and preserve their /D directory verbatim as the stock installer does.
  ${If} ${Silent}
    Call JokoEnsureDirectoryWritable
    ${If} ${Errors}
      SetErrorLevel 5
      Quit
    ${EndIf}
    ${If} ${UAC_IsInnerInstance}
      !insertmacro customCheckAppRunning
    ${EndIf}
  ${EndIf}
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !include "${JOKO_INSTALLER_RESOURCES}\installer-directory-messages.nsh"

    Function JokoGetUserSid
      StrCpy $jokoUserSid ""
      System::Call 'kernel32::GetCurrentProcess() p.r0'
      System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i.r2'
      ${If} $2 != 0
        ; TOKEN_USER starts with a SID pointer.
        System::Call 'advapi32::GetTokenInformation(p r1, i 1, p 0, i 0, *i .r2)'
        System::Alloc $2
        Pop $3
        ${If} $3 != 0
          System::Call 'advapi32::GetTokenInformation(p r1, i 1, p r3, i r2, *i .r4) i.r5'
          ${If} $5 != 0
            System::Call '*$3(p .r4)'
            System::Call 'advapi32::ConvertSidToStringSidW(p r4, *p .r5) i.r6'
            ${If} $6 != 0
              System::Call '*$5(&w${NSIS_MAX_STRLEN} .r6)'
              StrCpy $jokoUserSid $6
              System::Call 'kernel32::LocalFree(p r5)'
            ${EndIf}
          ${EndIf}
          System::Free $3
        ${EndIf}
        System::Call 'kernel32::CloseHandle(p r1)'
      ${EndIf}
    FunctionEnd

    Function JokoRestoreDirectory
      StrCpy $INSTDIR $jokoRequestedDirectory
      StrCpy $installMode $jokoRequestedMode
      ${If} $installMode == "CurrentUser"
        SetShellVarContext current
        StrCpy $hasPerUserInstallation "1"
        StrCpy $hasPerMachineInstallation "0"
      ${Else}
        SetShellVarContext all
        StrCpy $hasPerUserInstallation "0"
        StrCpy $hasPerMachineInstallation "1"
      ${EndIf}
    FunctionEnd

    Function JokoNormalizeDirectory
      ; Match the stock assisted installer's application subdirectory behavior.
      ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
      ${If} $0 == ""
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
    FunctionEnd

    Function JokoDirectoryPre
      ${If} $jokoDirectoryElevation == "1"
        ; The stock mode page assumes every UAC child is machine-wide. Restore
        ; the real choice after that page and resume without asking for it again.
        Call JokoRestoreDirectory
        Abort
      ${EndIf}
      ${If} ${isUpdated}
        Abort
      ${EndIf}
    FunctionEnd

    Function JokoDirectoryLeave
      ; NSIS commits the edit control to INSTDIR AFTER this callback. Read the
      ; current text so the probe checks the new choice, not the old directory.
      ${NSD_GetText} $mui.DirectoryPage.Directory $INSTDIR
      Call JokoNormalizeDirectory
      ${NSD_SetText} $mui.DirectoryPage.Directory $INSTDIR
      Call JokoEnsureDirectoryWritable
      ${If} ${Errors}
        Abort ; keep the directory page and selection when authorization fails
      ${EndIf}
    FunctionEnd

    Function JokoDirectoryBeforeInstall
      Call JokoNormalizeDirectory
      Call JokoEnsureDirectoryWritable
      ${If} ${Errors}
        ; Abort in an instfiles PRE would skip to the finish page. Quit instead.
        SetErrorLevel 5
        Quit
      ${EndIf}
      ${If} ${UAC_IsInnerInstance}
        !insertmacro customCheckAppRunning
      ${EndIf}
    FunctionEnd

    ; Probe the destination or its nearest existing parent without creating an
    ; installation tree. Delete only the unique file created by GetTempFileName.
    Function JokoProbeDirectory
      StrCpy $jokoDirectoryError 0
      StrCpy $0 $INSTDIR
      joko_probe_parent:
        System::Call 'kernel32::GetFileAttributesW(w r0) i.r1 ?e'
        Pop $2
        ${If} $1 == -1
          ${If} $2 != 2
          ${AndIf} $2 != 3
            StrCpy $jokoDirectoryError $2
            Return
          ${EndIf}
          ${GetParent} "$0" $1
          ${If} $1 == ""
          ${OrIf} $1 == $0
            StrCpy $jokoDirectoryError 3
            Return
          ${EndIf}
          StrCpy $0 $1
          Goto joko_probe_parent
        ${EndIf}
        IntOp $1 $1 & 0x10
        ${If} $1 == 0
          StrCpy $jokoDirectoryError 267 ; ERROR_DIRECTORY
          Return
        ${EndIf}
        System::Call 'kernel32::GetTempFileNameW(w r0, w "jko", i 0, w .r1) i.r2 ?e'
        Pop $3
        ${If} $2 == 0
          StrCpy $jokoDirectoryError $3
          Return
        ${EndIf}
        System::Call 'kernel32::DeleteFileW(w r1) i.r2 ?e'
        Pop $3
        ${If} $2 == 0
          StrCpy $jokoDirectoryError $3
          Return
        ${EndIf}
      ; Also catch a read-only/locked old icon in an otherwise writable directory.
      ; OPEN_EXISTING requests write access without changing any existing bytes.
      IfFileExists "$INSTDIR\uninstallerIcon.ico" 0 joko_probe_done
        System::Call 'kernel32::CreateFileW(w "$INSTDIR\uninstallerIcon.ico", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p.r1 ?e'
        Pop $2
        ${If} $1 == -1
          StrCpy $jokoDirectoryError $2
        ${Else}
          System::Call 'kernel32::CloseHandle(p r1)'
        ${EndIf}
      joko_probe_done:
    FunctionEnd

    Function JokoEnsureDirectoryWritable
      ClearErrors
      Call JokoProbeDirectory
      ${If} $jokoDirectoryError == 0
        Return
      ${EndIf}
      ; Only ACCESS_DENIED may be repaired by elevation. Do not prompt for a
      ; locked file, invalid path, full disk, or an already elevated process.
      ${If} $jokoDirectoryError == 5
      ${AndIfNot} ${UAC_IsAdmin}
        Call JokoGetUserSid
        ${If} $jokoUserSid != ""
          StrCpy $jokoRequestedUserSid $jokoUserSid
          StrCpy $jokoRequestedDirectory $INSTDIR
          StrCpy $jokoRequestedMode $installMode
          StrCpy $jokoDirectoryElevation "1"
          ShowWindow $HWNDPARENT ${SW_HIDE}
          !insertmacro UAC_RunElevated
          ${If} $0 == 0
          ${AndIf} $1 == 1
            ${If} $2 != ${JOKO_ELEVATION_DIFFERENT_USER}
              SetErrorLevel $2
              Quit ; the child has finished; never install again in the parent
            ${EndIf}
          ${EndIf}
          StrCpy $jokoDirectoryElevation "0"
          ShowWindow $HWNDPARENT ${SW_SHOW}
          BringToFront
          ${If} $0 == 1223
            SetErrors ; UAC cancelled: return to directory selection quietly
            Return
          ${EndIf}
          ${If} $0 == 0
          ${AndIf} $1 == 1
          ${AndIf} $2 == ${JOKO_ELEVATION_DIFFERENT_USER}
            !insertmacro jokoDirectoryMessage jokoDirectoryDifferentUser
            MessageBox MB_OK|MB_ICONEXCLAMATION "$jokoDirectoryMessage" /SD IDOK
            SetErrors
            Return
          ${EndIf}
        ${EndIf}
      ${EndIf}
      !insertmacro jokoDirectoryMessage jokoDirectoryNotWritable
      MessageBox MB_OK|MB_ICONEXCLAMATION "$jokoDirectoryMessage$\r$\n$\r$\n$INSTDIR$\r$\n($jokoDirectoryError)" /SD IDOK
      SetErrors
    FunctionEnd
  !endif
!macroend

!endif ; BUILD_UNINSTALLER
