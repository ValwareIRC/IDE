; Extra installer page: let the person choose which shortcuts Prism gets.
; electron-builder includes this file at the top of its NSIS script and calls
; the macros below at fixed points (see app-builder-lib/templates/nsis).

!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh

; "Open with Prism" in Explorer, for this person only (HKCU, so no administrator is needed).
; Windows 11 shows these under "Show more options": its short menu takes only apps that come
; with a signed package, which Prism does not have. Prism.exe opens what it is given (main/handover.ts).
!macro PrismExplorerVerb KEY ARG
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Prism" "" "Open with Prism"
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Prism" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Prism\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "${ARG}"'
!macroend

!macro PrismExplorerAdd
  !insertmacro PrismExplorerVerb "*" "%1"
  !insertmacro PrismExplorerVerb "Directory" "%V"
  !insertmacro PrismExplorerVerb "Directory\Background" "%V"
  ; the "Open with" list, for every kind of file
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Prism"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\*\OpenWithList\${APP_EXECUTABLE_FILENAME}" "" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro PrismExplorerRemove
  DeleteRegKey HKCU "Software\Classes\*\shell\Prism"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Prism"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Prism"
  DeleteRegKey HKCU "Software\Classes\*\OpenWithList\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!ifndef BUILD_UNINSTALLER
  Var PrismWantDesktop
  Var PrismWantStartMenu
  Var PrismDesktopBox
  Var PrismStartMenuBox
  Var PrismWantExplorer
  Var PrismExplorerBox

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
    ${NSD_CreateCheckbox} 0 70u 100% 12u "Add $\"Open with Prism$\" when you right-click files and folders"
    Pop $PrismExplorerBox

    ; both ticked unless unticked earlier in this run
    ${If} $PrismWantDesktop != "0"
      ${NSD_Check} $PrismDesktopBox
    ${EndIf}
    ${If} $PrismWantStartMenu != "0"
      ${NSD_Check} $PrismStartMenuBox
    ${EndIf}
    ${If} $PrismWantExplorer != "0"
      ${NSD_Check} $PrismExplorerBox
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
    ${NSD_GetState} $PrismExplorerBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $PrismWantExplorer "1"
    ${Else}
      StrCpy $PrismWantExplorer "0"
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
    ; an earlier install's entries go first, so unticking the box takes them away
    !insertmacro PrismExplorerRemove
    ${If} $PrismWantExplorer != "0"
      !insertmacro PrismExplorerAdd
    ${EndIf}
  !macroend
!endif

!macro customUnInstall
  !insertmacro PrismExplorerRemove
!macroend
