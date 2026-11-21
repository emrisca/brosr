; Stop Brosr and any detached helpers running out of $INSTDIR\resources\
; (bundled node.exe for the invite lobby/trust agent/pipe holder, and
; brosr-relay.exe) before NSIS overwrites or deletes those binaries.
!define BROSR_NSIS_DIR "${__FILEDIR__}"

!macro BROSR_STOP_BUNDLED_HELPERS
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop-helpers.ps1" "${BROSR_NSIS_DIR}\stop-helpers.ps1"
  DetailPrint "Stopping Brosr background helpers..."
  nsExec::ExecToLog /TIMEOUT=15000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-helpers.ps1" -InstallDir "$INSTDIR\."'
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro BROSR_STOP_BUNDLED_HELPERS
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro BROSR_STOP_BUNDLED_HELPERS
!macroend
