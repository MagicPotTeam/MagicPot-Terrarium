!include "LogicLib.nsh"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO "Delete MagicPot user configuration and cache?$\n$\nThis removes local settings, chat records, login state, runtime cache, and other user data.$\n$\nDirectory:$\n  $APPDATA\MagicPot\aiengineelectron$\n$\nChoose No if you plan to reinstall or update and want to keep API settings and Agent skills." IDYES deleteConfig IDNO skipDelete

    deleteConfig:
      RMDir /r "$APPDATA\MagicPot\aiengineelectron"
      RMDir "$APPDATA\MagicPot"
      goto done

    skipDelete:
      goto done

    done:
  ${endif}
!macroend
