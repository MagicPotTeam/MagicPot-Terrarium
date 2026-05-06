!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "uninstaller.nsh"

!define MAGICPOT_VC_REDIST_DOWNLOAD_URL "https://aka.ms/vs/17/release/vc_redist.x64.exe"

Var MagicPotVcRedistCheckbox
Var MagicPotInstallVcRedist

Function MagicPotVcRedistPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 34u "Pure mode does not bundle ComfyUI, but local ComfyUI on Windows may need Microsoft Visual C++ Redistributable x64. If selected, the installer downloads VC_redist.x64.exe from Microsoft during installation."
  Pop $0

  ${NSD_CreateCheckbox} 0 44u 100% 14u "Download and install Microsoft Visual C++ Redistributable x64 from Microsoft"
  Pop $MagicPotVcRedistCheckbox
  ${NSD_Uncheck} $MagicPotVcRedistCheckbox

  ${NSD_CreateLabel} 0 64u 100% 22u "Source: ${MAGICPOT_VC_REDIST_DOWNLOAD_URL}"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function MagicPotVcRedistPageLeave
  ${NSD_GetState} $MagicPotVcRedistCheckbox $MagicPotInstallVcRedist
FunctionEnd

!macro customPageAfterChangeDir
  Page custom MagicPotVcRedistPageCreate MagicPotVcRedistPageLeave
!macroend

!macro customInstall
  ${If} $MagicPotInstallVcRedist == "1"
    DetailPrint "Downloading and installing Microsoft Visual C++ Redistributable x64..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = ''Stop''; $$uri = ''${MAGICPOT_VC_REDIST_DOWNLOAD_URL}''; $$out = Join-Path $$env:TEMP ''MagicPot-VC_redist.x64.exe''; Invoke-WebRequest -UseBasicParsing -Uri $$uri -OutFile $$out; $$p = Start-Process -FilePath $$out -ArgumentList ''/install /quiet /norestart'' -Wait -Verb RunAs -PassThru; if ($$null -ne $$p.ExitCode) { exit $$p.ExitCode }"'
    Pop $0
    ${If} $0 != "0"
      MessageBox MB_ICONEXCLAMATION|MB_OK "Microsoft Visual C++ Redistributable installation did not complete. You can install it later from https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist"
    ${EndIf}
  ${EndIf}
!macroend
