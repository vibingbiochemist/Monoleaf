; NSIS installer hooks (bundle > windows > nsis > installerHooks in
; tauri.conf.json), included into Tauri's own installer template.
;
; Why this exists: before replacing the files, the installer asks the Windows
; Restart Manager which processes are using monoleaf.exe and shuts them down.
; Tauri CLI 2.11 looked only for a process *named* monoleaf.exe; from 2.12
; (tauri-apps/tauri#14479) any user of the file counts, and a service the
; Restart Manager classes as critical cannot be shut down, so the installer
; stops with "Failed to kill Monoleaf. Please close it first then try again".
;
; On a machine with an on-access virus scanner that is what happens on every
; in-app update: Monoleaf exits, the scanner (seen: Cisco Secure Endpoint,
; also the Windows Inventory and Compatibility Appraisal service) opens the
; executable for about a second, and the installer's check lands inside that
; second. Monoleaf itself is long gone by then. Every update from 1.2.1 to
; 1.3.0 and 1.3.1 failed this way.
;
; NSIS_HOOK_PREINSTALL runs immediately before that check. It repeats the
; check's own query (RmGetList) every quarter second, for up to ten seconds,
; until nothing is using the file, so the check then finds nothing to shut
; down. One exception: while the executable cannot even be opened for
; writing, Monoleaf itself is still running (an image in use is locked); if
; that lasts five seconds it is not just closing, so the wait ends and
; Tauri's check closes it as before.

!macro NSIS_HOOK_PREINSTALL
  ; RmGetList writes $0-$3; the macros below use $0 and the stack.
  Push $0
  Push $1
  Push $2
  Push $3
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  StrCpy $R9 0 ; polls so far (40 x 250 ms = 10 s)
  StrCpy $R7 0 ; consecutive polls with the executable locked
  monoleaf_wait_poll:
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 monoleaf_wait_done
    ClearErrors
    ; Append mode opens without truncating or writing anything.
    FileOpen $R8 "$INSTDIR\${MAINBINARYNAME}.exe" a
    IfErrors monoleaf_wait_locked
    FileClose $R8
    StrCpy $R7 0
    ; Not locked, so Monoleaf is gone. Is anything else still holding it?
    !insertmacro RestartManager_StartSession $R6
    StrCmp $R6 "" monoleaf_wait_done
    !insertmacro RestartManager_RegisterFile $R6 "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCmp $0 0 0 monoleaf_wait_end_session
    System::Call 'RSTRTMGR::RmGetList(i R6, *i .r1, *i .r2, p 0, *i .r3) i .r0'
    !insertmacro RestartManager_EndSession $R6
    ; ERROR_SUCCESS: nobody uses the file, Tauri's check will pass.
    StrCmp $0 0 monoleaf_wait_done monoleaf_wait_next
  monoleaf_wait_end_session:
    !insertmacro RestartManager_EndSession $R6
    Goto monoleaf_wait_done
  monoleaf_wait_locked:
    IntOp $R7 $R7 + 1
    IntCmp $R7 20 monoleaf_wait_done
  monoleaf_wait_next:
    IntOp $R9 $R9 + 1
    IntCmp $R9 40 monoleaf_wait_done
    Sleep 250
    Goto monoleaf_wait_poll
  monoleaf_wait_done:
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
