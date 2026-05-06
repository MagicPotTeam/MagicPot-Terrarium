!macro customUnInstall
  ; 询问用户是否删除配置文件和缓存
  MessageBox MB_YESNO "是否删除用户配置文件和缓存？$\n$\n删除后将清除所有设置、聊天记录、Gemini 登录状态等，下次安装时需要重新配置。$\n$\n将删除以下目录:$\n  $APPDATA\aiengineelectron" IDYES deleteConfig IDNO skipDelete
  
  deleteConfig:
    ; 删除生产版本的数据目录
    RMDir /r "$APPDATA\aiengineelectron"
    goto done
    
  skipDelete:
    goto done
    
  done:
!macroend
