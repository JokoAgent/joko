!define JOKO_INSTALLER_RESOURCES "${__FILEDIR__}"
!include "${JOKO_INSTALLER_RESOURCES}\installer-directory.nsh"

!ifndef BUILD_UNINSTALLER
!macro customInit
  !insertmacro jokoDirectoryInit
!macroend

; Check after destination authorization and before replacing the application.
!macro customCheckAppRunning
  joko_check_running:
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
        "${PRODUCT_FILENAME} is running. Close it before continuing installation.$\n$\nSelect OK to close it and continue." \
        /SD IDCANCEL IDOK joko_kill_app
      SetErrorLevel 1602
      Quit
      joko_kill_app:
        nsProcess::_KillProcess "${APP_EXECUTABLE_FILENAME}"
        Sleep 1000
        Goto joko_check_running
    ${EndIf}
!macroend
!endif

; The old uninstaller also runs during upgrade. Remove its path-bound service
; before its image or protected application files can be deleted or replaced.
!macro customUnInit
  IfFileExists "$INSTDIR\resources\native-remote-desktop\joko-windows-remote-desktop-host.exe" 0 joko_remote_service_done
  nsExec::ExecToStack '"$INSTDIR\resources\native-remote-desktop\joko-windows-remote-desktop-host.exe" --uninstall'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    nsExec::ExecToStack '"$INSTDIR\resources\native-remote-desktop\joko-windows-remote-desktop-host.exe" --elevate-uninstall'
    Pop $R0
    Pop $R1
  ${EndIf}
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Could not stop the Joko Remote Desktop service. Run the uninstaller as administrator and try again." /SD IDOK
    SetErrorLevel 5
    Abort
  ${EndIf}
  joko_remote_service_done:
!macroend
