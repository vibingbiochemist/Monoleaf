; NSIS installer hooks (bundle > windows > nsis > installerHooks in
; tauri.conf.json), included into Tauri's own installer template.
;
; Why this exists: an in-app update hands off to the installer and exits in the
; same breath (tauri-plugin-updater: ShellExecuteW, then
; std::process::exit(0)). The installer then checks whether Monoleaf is still
; running and, if so, shuts it down. Up to Tauri CLI 2.11 that check
; (nsis_tauri_utils::KillProcess) treated "already gone" as success and slept
; 500 ms afterwards (tauri-apps/tauri#12309). From 2.12 it uses the Windows
; Restart Manager (tauri-apps/tauri#14479), and RmShutdown on a process that is
; still exiting fails, so the installer stopped with "Failed to kill Monoleaf"
; and every update from 1.2.1 to 1.3.0 failed.
;
; NSIS_HOOK_PREINSTALL runs immediately before that check. It waits, at most
; five seconds, until the installed executable is no longer held by a running
; process: an image file in use cannot be opened for writing. Once it can, the
; old process is gone and the Restart Manager check finds nothing to close.
; If the app is genuinely still open (the installer run by hand while Monoleaf
; is in use) the wait runs out and Tauri's own check handles it as before.

!macro NSIS_HOOK_PREINSTALL
  Push $R8
  Push $R9
  StrCpy $R9 0
  monoleaf_wait_for_exit:
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 monoleaf_wait_done
    ClearErrors
    ; Append mode opens without truncating or writing anything.
    FileOpen $R8 "$INSTDIR\${MAINBINARYNAME}.exe" a
    IfErrors 0 monoleaf_exe_released
    IntOp $R9 $R9 + 1
    IntCmp $R9 20 monoleaf_wait_done
    Sleep 250
    Goto monoleaf_wait_for_exit
  monoleaf_exe_released:
    FileClose $R8
  monoleaf_wait_done:
  Pop $R9
  Pop $R8
!macroend
