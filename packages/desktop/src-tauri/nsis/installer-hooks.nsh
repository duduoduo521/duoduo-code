; installer-hooks.nsh
; NSIS installer hooks for DuoDuoCode
; Closes running sidecar processes before installation
; to prevent "unable to open file for writing" errors on Windows.

; NSIS_HOOK_PREINSTALL runs BEFORE file extraction in the Install section.
; The built-in CheckIfAppIsRunning only checks DuoDuoCode.exe,
; not the sidecar processes. We must kill them here.

!macro NSIS_HOOK_PREINSTALL
  ; Kill the main application process so overwrite install can replace the locked exe
  nsExec::ExecToStack `taskkill /F /IM "DuoDuoCode.exe"`

  ; Kill sidecar processes (these are the actual process names in Task Manager)
  nsExec::ExecToStack `taskkill /F /IM "duo-smart-layer.exe"`
  nsExec::ExecToStack `taskkill /F /IM "duoduocode-cli.exe"`

  ; Also try target-triple suffixed names (sidecar binaries on disk)
  nsExec::ExecToStack `taskkill /F /IM "duo-smart-layer-x86_64-pc-windows-msvc.exe"`
  nsExec::ExecToStack `taskkill /F /IM "duoduocode-cli-x86_64-pc-windows-msvc.exe"`

  ; Wait for Windows to release file handles
  Sleep 1500

  ; ---- Remove leftovers from the previous version before overwriting ----
  ; An overwrite install (same version / upgrade, see the "DuoDuoCode
  ; customization" block in installer.nsis) only replaces the files this build
  ; ships. Anything renamed or dropped between versions stays behind and is a
  ; classic source of hard-to-diagnose breakage. Delete exactly the parts that
  ; are fully owned by the installer:
  ;   - resources/{node,binaries,packages}: the LSP runtime injected by
  ;     release-windows.ps1 via bundle.resources, replaced wholesale
  ;   - sidecar executables: shipped with or without the target-triple suffix,
  ;     so a rename leaves the stale binary next to the new one
  ; Nothing else in $INSTDIR is touched on purpose: with the default
  ; installMode ("currentUser") $INSTDIR is %LOCALAPPDATA%\DuoDuoCode, the same
  ; directory as the cli data dir %LOCALAPPDATA%\duoduocode (case-insensitive),
  ; which holds the user's log/, gears/ and state/.
  ${If} ${FileExists} "$INSTDIR\DuoDuoCode.exe"
  ${OrIf} ${FileExists} "$INSTDIR\uninstall.exe"
    RMDir /r "$INSTDIR\resources\node"
    RMDir /r "$INSTDIR\resources\binaries"
    RMDir /r "$INSTDIR\resources\packages"
    Delete "$INSTDIR\duoduocode-cli*.exe"
    Delete "$INSTDIR\duo-smart-layer*.exe"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Kill the main application process FIRST. `Section Uninstall` does
  ; `Delete "$INSTDIR\DuoDuoCode.exe"`, and Delete silently no-ops while the
  ; file is still held open. The reinstall section of the Tauri NSIS template
  ; then aborts with "unable to uninstall" whenever that exe survives, which is
  ; what makes an overwrite install look like it requires uninstalling first.
  ; `CheckIfAppIsRunning` only sleeps 500ms after killing, which is not enough
  ; for the main window process plus its two sidecar children.
  nsExec::ExecToStack `taskkill /F /IM "DuoDuoCode.exe"`

  nsExec::ExecToStack `taskkill /F /IM "duo-smart-layer.exe"`
  nsExec::ExecToStack `taskkill /F /IM "duoduocode-cli.exe"`
  nsExec::ExecToStack `taskkill /F /IM "duo-smart-layer-x86_64-pc-windows-msvc.exe"`
  nsExec::ExecToStack `taskkill /F /IM "duoduocode-cli-x86_64-pc-windows-msvc.exe"`

  ; Wait for Windows to release file handles (matches NSIS_HOOK_PREINSTALL)
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; `Section Uninstall` only deletes the exact files the bundler registered,
  ; so the injected LSP runtime trees (resources/node, resources/packages,
  ; resources/binaries) survive and the uninstall looks incomplete.
  ; Remove them here, then drop resources/ itself once it is empty.

  ; WARNING: NEVER do `RMDir /r "$INSTDIR"` here:
  ; with the default installMode ("currentUser") $INSTDIR is
  ; %LOCALAPPDATA%\DuoDuoCode, while duoduocode-cli keeps all of its runtime
  ; data in %LOCALAPPDATA%\duoduocode
  ; (packages/duoduo/src/global/index.ts: data = join(localAppData, "duoduocode"),
  ; and log/ gears/ state/ live under it). Windows paths are case-insensitive,
  ; so those two are the SAME directory on a default install and wiping
  ; $INSTDIR would silently delete the user's data.
  ; Tauri's own "delete app data" checkbox only covers $APPDATA/$LOCALAPPDATA
  ; <bundleId> (com.duoduo.desktop), never this folder.
  StrCmp "$INSTDIR" "" wipe_done
  RMDir /r "$INSTDIR\resources\node"
  RMDir /r "$INSTDIR\resources\binaries"
  RMDir /r "$INSTDIR\resources\packages"
  RMDir "$INSTDIR\resources"
  wipe_done:
!macroend
