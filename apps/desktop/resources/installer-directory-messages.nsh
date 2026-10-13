; NSIS runs before Electron/i18next. Keep the five client languages here, with
; English fallback for other installer languages. Windows styles the dialogs.
!macro jokoDirectoryMessage KEY
  ${Switch} $LANGUAGE
    ${Case} 2052 ; zh-CN
      StrCpy $jokoDirectoryMessage "${${KEY}_zh_CN}"
      ${Break}
    ${Case} 1028 ; zh-TW
      StrCpy $jokoDirectoryMessage "${${KEY}_zh_TW}"
      ${Break}
    ${Case} 1041 ; ja
      StrCpy $jokoDirectoryMessage "${${KEY}_ja}"
      ${Break}
    ${Case} 1042 ; ko
      StrCpy $jokoDirectoryMessage "${${KEY}_ko}"
      ${Break}
    ${Default}
      StrCpy $jokoDirectoryMessage "${${KEY}_en}"
      ${Break}
  ${EndSwitch}
!macroend

!define jokoDirectoryNotWritable_en "Joko cannot write to this installation directory. Choose another directory, or close apps using its files and check your security software before trying again."
!define jokoDirectoryNotWritable_zh_CN "Joko 无法写入这个安装目录。请选择其他目录，或关闭占用文件的程序并检查安全软件后重试。"
!define jokoDirectoryNotWritable_zh_TW "Joko 無法寫入這個安裝目錄。請選擇其他目錄，或關閉占用檔案的程式並檢查安全軟體後重試。"
!define jokoDirectoryNotWritable_ja "このインストール先に Joko を書き込めません。別のディレクトリを選ぶか、ファイルを使用中のアプリを閉じ、セキュリティソフトを確認してから再試行してください。"
!define jokoDirectoryNotWritable_ko "이 설치 디렉터리에 Joko를 쓸 수 없습니다. 다른 디렉터리를 선택하거나 파일을 사용 중인 앱을 닫고 보안 소프트웨어를 확인한 후 다시 시도하세요."

!define jokoDirectoryDifferentUser_en "Windows authorization used a different account. To keep Joko installed for your account, choose a directory you can write to. To install for all users, go back and select that option."
!define jokoDirectoryDifferentUser_zh_CN "Windows 授权使用了另一个账号。如需仅为当前账号安装 Joko，请选择可写入的目录；如需为所有用户安装，请返回并选择该选项。"
!define jokoDirectoryDifferentUser_zh_TW "Windows 授權使用了另一個帳號。如需僅為目前帳號安裝 Joko，請選擇可寫入的目錄；如需為所有使用者安裝，請返回並選擇該選項。"
!define jokoDirectoryDifferentUser_ja "Windows の認証に別のアカウントが使われました。現在のアカウントにのみ Joko をインストールするには、書き込み可能なディレクトリを選んでください。すべてのユーザーにインストールするには、前の画面でそのオプションを選んでください。"
!define jokoDirectoryDifferentUser_ko "Windows 인증에 다른 계정이 사용되었습니다. 현재 계정에만 Joko를 설치하려면 쓰기 가능한 디렉터리를 선택하세요. 모든 사용자에게 설치하려면 이전 화면으로 돌아가 해당 옵션을 선택하세요."
