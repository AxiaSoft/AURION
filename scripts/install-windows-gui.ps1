# AURION Secure GUI Installer - Windows Forms
# Downloads Python 3.12 + Node.js LTS with TLS verification and progress bar

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$form = New-Object System.Windows.Forms.Form
$form.Text = "AURION - نصب امن پیش‌نیازها"
$form.Size = New-Object System.Drawing.Size(600, 450)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(6, 7, 11)

$labelTitle = New-Object System.Windows.Forms.Label
$labelTitle.Text = "🚀 نصب AURION - دانلود امن پیش‌نیازها"
$labelTitle.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$labelTitle.ForeColor = [System.Drawing.Color]::White
$labelTitle.Location = New-Object System.Drawing.Point(20, 20)
$labelTitle.Size = New-Object System.Drawing.Size(540, 30)
$form.Controls.Add($labelTitle)

$labelStatus = New-Object System.Windows.Forms.Label
$labelStatus.Text = "بررسی سیستم..."
$labelStatus.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$labelStatus.ForeColor = [System.Drawing.Color]::FromArgb(180, 190, 210)
$labelStatus.Location = New-Object System.Drawing.Point(20, 60)
$labelStatus.Size = New-Object System.Drawing.Size(540, 20)
$form.Controls.Add($labelStatus)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(20, 90)
$progress.Size = New-Object System.Drawing.Size(540, 25)
$progress.Style = "Continuous"
$form.Controls.Add($progress)

$listBox = New-Object System.Windows.Forms.ListBox
$listBox.Location = New-Object System.Drawing.Point(20, 130)
$listBox.Size = New-Object System.Drawing.Size(540, 200)
$listBox.BackColor = [System.Drawing.Color]::FromArgb(8, 10, 18)
$listBox.ForeColor = [System.Drawing.Color]::FromArgb(200, 210, 230)
$listBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$form.Controls.Add($listBox)

$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Text = "نصب خودکار"
$btnInstall.Location = New-Object System.Drawing.Point(20, 350)
$btnInstall.Size = New-Object System.Drawing.Size(150, 40)
$btnInstall.BackColor = [System.Drawing.Color]::FromArgb(79, 70, 229)
$btnInstall.ForeColor = [System.Drawing.Color]::White
$btnInstall.FlatStyle = "Flat"
$btnInstall.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($btnInstall)

$btnLogs = New-Object System.Windows.Forms.Button
$btnLogs.Text = "باز کردن لاگ"
$btnLogs.Location = New-Object System.Drawing.Point(180, 350)
$btnLogs.Size = New-Object System.Drawing.Size(120, 40)
$btnLogs.BackColor = [System.Drawing.Color]::FromArgb(30, 35, 58)
$btnLogs.ForeColor = [System.Drawing.Color]::White
$btnLogs.FlatStyle = "Flat"
$form.Controls.Add($btnLogs)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = "بستن"
$btnClose.Location = New-Object System.Drawing.Point(460, 350)
$btnClose.Size = New-Object System.Drawing.Size(100, 40)
$btnClose.BackColor = [System.Drawing.Color]::FromArgb(50, 50, 60)
$btnClose.ForeColor = [System.Drawing.Color]::White
$btnClose.FlatStyle = "Flat"
$form.Controls.Add($btnClose)

function Add-Log($msg) {
    $time = Get-Date -Format "HH:mm:ss"
    $listBox.Items.Add("[$time] $msg") | Out-Null
    $listBox.TopIndex = $listBox.Items.Count - 1
    $form.Refresh()
    $logDir = Join-Path $Root "data\logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    Add-Content -Path (Join-Path $logDir "installer-gui.log") -Value "[$time] $msg"
}

function Set-Status($txt, $pct) {
    $labelStatus.Text = $txt
    $progress.Value = [Math]::Min(100, [Math]::Max(0, $pct))
    $form.Refresh()
}

function Test-Py312 {
    try {
        $out = & py -3.12 -c "import sys; print('3.12' if sys.version_info[:2]==(3,12) else 'no')" 2>$null
        return ([string]$out).Trim() -eq '3.12'
    } catch { return $false }
}

function Test-Node {
    try {
        $v = & node -p "process.versions.node.split('.')[0]" 2>$null
        return [int]([string]$v).Trim() -ge 18
    } catch { return $false }
}

$btnLogs.Add_Click({
    $logPath = Join-Path $Root "data\logs"
    if (Test-Path $logPath) { Start-Process explorer.exe $logPath }
})

$btnClose.Add_Click({ $form.Close() })

$btnInstall.Add_Click({
    $btnInstall.Enabled = $false
    Add-Log "شروع نصب امن..."
    Set-Status "در حال دانلود و نصب..." 10
    try {
        $psInstall = Join-Path $Root "scripts\install-windows.ps1"
        if (Test-Path $psInstall) {
            Add-Log "اجرای نصب‌کننده اصلی..."
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = "powershell"
            $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$psInstall`""
            $psi.WorkingDirectory = $Root
            $psi.UseShellExecute = $false
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.CreateNoWindow = $true
            $proc = [System.Diagnostics.Process]::Start($psi)
            $proc.OutputDataReceived.Add({ param($s,$e) if($e.Data){ Add-Log $e.Data } })
            $proc.ErrorDataReceived.Add({ param($s,$e) if($e.Data){ Add-Log $e.Data } })
            $proc.BeginOutputReadLine()
            $proc.BeginErrorReadLine()
            $proc.WaitForExit()
            if ($proc.ExitCode -eq 0) {
                Set-Status "نصب کامل شد! ✅" 100
                Add-Log "✅ تمام پیش‌نیازها نصب شد"
                Add-Log "در حال راه‌اندازی AURION..."
                Start-Sleep -Seconds 1
                $starter = Join-Path $Root "start-aurion.cmd"
                if (Test-Path $starter) { Start-Process -FilePath $starter -WorkingDirectory $Root }
                $form.Close()
            } else {
                Set-Status "خطا در نصب" 0
                Add-Log "❌ نصب با خطا مواجه شد: exit $($proc.ExitCode)"
                $btnInstall.Enabled = $true
            }
        } else {
            Add-Log "فایل نصب‌کننده یافت نشد: $psInstall"
            $btnInstall.Enabled = $true
        }
    } catch {
        Add-Log "خطا: $($_.Exception.Message)"
        Set-Status "خطا" 0
        $btnInstall.Enabled = $true
    }
})

# Initial check
Add-Log "بررسی پیش‌نیازها..."
if (Test-Py312) { Add-Log "✅ Python 3.12 نصب شده" } else { Add-Log "❌ Python 3.12 نیاز به نصب" }
if (Test-Node) { Add-Log "✅ Node.js نصب شده" } else { Add-Log "❌ Node.js نیاز به نصب" }
Set-Status "آماده نصب - کلیک کنید" 0

[void]$form.ShowDialog()
