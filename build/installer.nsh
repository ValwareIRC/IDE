; Extra installer page: let the person choose which shortcuts Prism gets.
; electron-builder includes this file at the top of its NSIS script and calls
; the macros below at fixed points (see app-builder-lib/templates/nsis).

!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var PrismWantDesktop
  Var PrismWantStartMenu
  Var PrismDesktopBox
  Var PrismStartMenuBox

  Function PrismShortcutsPage
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose where Prism should appear."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "Prism can add shortcuts so it is easy to open. To change this later, run this installer again."
    Pop $0

    ${NSD_CreateCheckbox} 0 34u 100% 12u "Add a shortcut to the &desktop"
    Pop $PrismDesktopBox
    ${NSD_CreateCheckbox} 0 52u 100% 12u "Add Prism to the &Start menu"
    Pop $PrismStartMenuBox

    ; both ticked unless unticked earlier in this run
    ${If} $PrismWantDesktop != "0"
      ${NSD_Check} $PrismDesktopBox
    ${EndIf}
    ${If} $PrismWantStartMenu != "0"
      ${NSD_Check} $PrismStartMenuBox
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function PrismShortcutsLeave
    ${NSD_GetState} $PrismDesktopBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $PrismWantDesktop "1"
    ${Else}
      StrCpy $PrismWantDesktop "0"
    ${EndIf}
    ${NSD_GetState} $PrismStartMenuBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $PrismWantStartMenu "1"
    ${Else}
      StrCpy $PrismWantStartMenu "0"
    ${EndIf}
  FunctionEnd

  !macro customPageAfterChangeDir
    Page custom PrismShortcutsPage PrismShortcutsLeave
  !macroend

  ; The stock installer has just created both shortcuts (with the right app id,
  ; and known to the uninstaller). Take away the ones that were not wanted.
  !macro customInstall
    ${If} $PrismWantDesktop == "0"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${EndIf}
    ${If} $PrismWantStartMenu == "0"
      WinShell::UninstShortcut "$newStartMenuLink"
      Delete "$newStartMenuLink"
      ; "Run Prism" on the last page must not point at the shortcut that was just removed
      StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${EndIf}
  !macroend
!endif
