<#
.SYNOPSIS
    Turn any picture into a real Windows icon.

.DESCRIPTION
    A .ico is not an image format, it is a container holding several bitmaps
    at several sizes. Renaming logo.png to logo.ico produces a file that
    Explorer will not draw and that the C# compiler rejects outright with:

        CSC : error CS7065: Error building Win32 resources --
              Icon stream is not in the expected format.

    This writes a proper one: 256 stored as PNG the way Vista and later
    expect, and 128, 64, 48, 32, 24 and 16 as 32-bit DIBs with an alpha
    channel, which is the arrangement every version of Windows and every
    toolchain reads without complaint.

    Pure PowerShell and System.Drawing - nothing to install.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\make-icon.ps1 `
        -Source my-logo.png -Destination installer\assets\generated\aurion.ico
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [int[]]$Sizes = @(256, 128, 64, 48, 32, 24, 16)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

function New-SquareBitmap {
    param([System.Drawing.Image]$Image, [int]$Size)

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size,
        ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

        # Fit the whole picture inside the square without distorting it: a
        # logo that is 255x256 must not be stretched to fill a 256 box.
        $scale = [Math]::Min($Size / $Image.Width, $Size / $Image.Height)
        $w = [Math]::Max(1, [int][Math]::Round($Image.Width * $scale))
        $h = [Math]::Max(1, [int][Math]::Round($Image.Height * $scale))
        $x = [int](($Size - $w) / 2)
        $y = [int](($Size - $h) / 2)
        $g.DrawImage($Image, $x, $y, $w, $h)
    } finally {
        $g.Dispose()
    }
    return $bmp
}

function Get-PngBytes {
    param([System.Drawing.Bitmap]$Bitmap)
    $ms = New-Object System.IO.MemoryStream
    try {
        $Bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        return $ms.ToArray()
    } finally { $ms.Dispose() }
}

function Get-DibBytes {
    <#
        A DIB inside an icon is a 40-byte BITMAPINFOHEADER whose biHeight is
        DOUBLE the real height - the colour rows plus a 1-bit AND mask that
        32-bit icons do not use but must still allocate - followed by the
        pixels bottom-up in BGRA, then the mask.
    #>
    param([System.Drawing.Bitmap]$Bitmap)

    $size = $Bitmap.Width
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $locked = $Bitmap.LockBits($rect,
        [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

    $rowBytes = $size * 4
    $pixels = New-Object byte[] ($rowBytes * $size)
    try {
        for ($y = 0; $y -lt $size; $y++) {
            $from = [IntPtr]::Add($locked.Scan0, ($size - 1 - $y) * $locked.Stride)
            [System.Runtime.InteropServices.Marshal]::Copy($from, $pixels, $y * $rowBytes, $rowBytes)
        }
    } finally {
        $Bitmap.UnlockBits($locked)
    }

    $maskRow = [int](([Math]::Floor(($size + 31) / 32)) * 4)
    $mask = New-Object byte[] ($maskRow * $size)

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    try {
        $bw.Write([uint32]40)                      # biSize
        $bw.Write([int32]$size)                    # biWidth
        $bw.Write([int32]($size * 2))              # biHeight - colours + mask
        $bw.Write([uint16]1)                       # biPlanes
        $bw.Write([uint16]32)                      # biBitCount
        $bw.Write([uint32]0)                       # biCompression = BI_RGB
        $bw.Write([uint32]($pixels.Length + $mask.Length))
        $bw.Write([int32]0); $bw.Write([int32]0)   # pixels per metre
        $bw.Write([uint32]0); $bw.Write([uint32]0) # palette
        $bw.Write($pixels)
        $bw.Write($mask)
        $bw.Flush()
        return $ms.ToArray()
    } finally {
        $bw.Dispose(); $ms.Dispose()
    }
}

$srcPath = (Resolve-Path -LiteralPath $Source).Path
$image = [System.Drawing.Image]::FromFile($srcPath)
$images = @()
try {
    foreach ($size in ($Sizes | Sort-Object -Descending -Unique)) {
        $bmp = New-SquareBitmap -Image $image -Size $size
        try {
            $bytes = if ($size -ge 256) { Get-PngBytes $bmp } else { Get-DibBytes $bmp }
            $images += [pscustomobject]@{ Size = $size; Bytes = $bytes }
        } finally { $bmp.Dispose() }
    }
} finally {
    $image.Dispose()
}

$dir = Split-Path -Parent $Destination
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$out = [System.IO.File]::Create($Destination)
$writer = New-Object System.IO.BinaryWriter $out
try {
    $writer.Write([uint16]0)                 # reserved
    $writer.Write([uint16]1)                 # type 1 = icon
    $writer.Write([uint16]$images.Count)

    $offset = 6 + 16 * $images.Count
    foreach ($img in $images) {
        # 256 is written as 0: the field is one byte and 256 does not fit.
        $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
        $writer.Write([byte]$dim)            # width
        $writer.Write([byte]$dim)            # height
        $writer.Write([byte]0)               # palette entries
        $writer.Write([byte]0)               # reserved
        $writer.Write([uint16]1)             # colour planes
        $writer.Write([uint16]32)            # bits per pixel
        $writer.Write([uint32]$img.Bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $img.Bytes.Length
    }
    foreach ($img in $images) { $writer.Write($img.Bytes) }
    $writer.Flush()
} finally {
    $writer.Dispose(); $out.Dispose()
}

$written = (Get-Item -LiteralPath $Destination).Length
$list = ($images | ForEach-Object { "{0}x{0}" -f $_.Size }) -join ", "
Write-Host ("  icon written: {0} ({1:N0} bytes, {2})" -f $Destination, $written, $list) -ForegroundColor Gray
