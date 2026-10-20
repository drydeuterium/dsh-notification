<#
.SYNOPSIS
  トースト通知が OS まで届くかを、DSH を介さず 1 件だけ確かめる。

.DESCRIPTION
  Windows PowerShell 5.1 で実行すること（WinRT の型は PowerShell 7 では読めない）。
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\toast-check.ps1

  通知は非同期に表示されるので、このスクリプトの終了コード 0 は
  「トーストの投入に成功した」ことまでしか保証しない。実際に登録されたかは
    python tools/wpn-history.py
  で確認する。

.PARAMETER Title
  1 行目（太字）。

.PARAMETER Body
  2 行目。

.PARAMETER AppId
  トーストのアプリ identity。プラグインと同じ既定値にしてある。
  未登録でも表示はされるが、アプリ名とアイコンが付かない。
#>
param(
  [string]$Title = "🔔 DSH 通知テスト",
  [string]$Body = "このトーストが見えれば、OS までの経路は生きている",
  [string]$AppId = "DeepSeekHarness.DesktopNotify"
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSEdition -eq "Core") {
  throw "Windows PowerShell 5.1 で実行してください: powershell.exe -NoProfile -File tools\toast-check.ps1"
}

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]

function ConvertTo-XmlText([string]$text) {
  return $text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;").Replace("'", "&apos;")
}

$xml = @"
<toast duration="long">
  <visual><binding template="ToastGeneric">
    <text>$(ConvertTo-XmlText $Title)</text>
    <text>$(ConvertTo-XmlText $Body)</text>
  </binding></visual>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>
"@

$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)

Write-Output "toast submitted (AppId=$AppId)"
Write-Output "確認: python tools/wpn-history.py"
