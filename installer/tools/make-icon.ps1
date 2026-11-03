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

# ---------------------------------------------------------------------------
# Emitting bytes
# ---------------------------------------------------------------------------
# Every integer below goes through [BitConverter], never BinaryWriter.
#
# This is not style. BinaryWriter.Write is heavily overloaded, and Windows
# PowerShell 5.1 resolves Write([uint16]32) to Write(Char) - which encodes the
# value as UTF-8 and writes ONE byte, not two. Each 16-byte icon directory
# entry then came out 14 bytes long, every image offset was wrong by a growing
# amount, and the last entry pointed past the end of the file. The compiler
# said:
#
#     CSC : error CS7065: Error building Win32 resources --
#           Unable to read beyond the end of the stream.
#
# which names neither PowerShell nor the icon. The same script on PowerShell 7
# picked the numeric overload and produced a perfectly good file, so the bug
# only appeared on other people's machines.
#
# [BitConverter]::GetBytes has one overload per type and no ambiguity.
function Add-U16 { param($List, [uint16]$Value) $List.AddRange([BitConverter]::GetBytes($Value)) }
function Add-U32 { param($List, [uint32]$Value) $List.AddRange([BitConverter]::GetBytes($Value)) }
function Add-I32 { param($List, [int32]$Value)  $List.AddRange([BitConverter]::GetBytes($Value)) }

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

    $out = New-Object "System.Collections.Generic.List[byte]"
    Add-U32 $out 40                                 # biSize
    Add-I32 $out $size                              # biWidth
    Add-I32 $out ($size * 2)                        # biHeight - colours + mask
    Add-U16 $out 1                                  # biPlanes
    Add-U16 $out 32                                 # biBitCount
    Add-U32 $out 0                                  # biCompression = BI_RGB
    Add-U32 $out ($pixels.Length + $mask.Length)    # biSizeImage
    Add-I32 $out 0; Add-I32 $out 0                  # pixels per metre
    Add-U32 $out 0; Add-U32 $out 0                  # palette
    $out.AddRange($pixels)
    $out.AddRange($mask)
    return $out.ToArray()
}

<#
    Re-read what was just produced and prove it is a well-formed icon.

    The writer above is the only thing standing between a logo and a build
    failure that names neither of them, so it checks its own work: the header
    is sane, every directory entry is 16 bytes where it should be, and no
    image runs past the end of the file. That last one is exactly what the
    compiler complains about, and it is far better said here.
#>
function Test-IconBytes {
    param([byte[]] $Bytes)

    if ($Bytes.Length -lt 6) { throw "the icon is only $($Bytes.Length) bytes long" }
    if ([BitConverter]::ToUInt16($Bytes, 0) -ne 0) { throw "the icon's reserved field is not zero" }
    if ([BitConverter]::ToUInt16($Bytes, 2) -ne 1) { throw "the icon's type field is not 1" }

    $count = [BitConverter]::ToUInt16($Bytes, 4)
    if ($count -lt 1) { throw "the icon claims to contain no images" }

    $need = 6 + 16 * $count
    if ($Bytes.Length -lt $need) {
        throw "the icon claims $count images but is too short to hold their directory"
    }

    for ($i = 0; $i -lt $count; $i++) {
        $at     = 6 + 16 * $i
        $size   = [BitConverter]::ToUInt32($Bytes, $at + 8)
        $offset = [BitConverter]::ToUInt32($Bytes, $at + 12)
        if ($offset -lt $need) {
            throw "image $i starts at $offset, inside the directory - the entries are the wrong width"
        }
        if ($offset + $size -gt $Bytes.Length) {
            throw "image $i runs to $($offset + $size) but the file is only $($Bytes.Length) bytes"
        }
    }
}

$srcPath = (Resolve-Path -LiteralPath $Source).Path

# The source may itself be an icon - a valid container that some toolchain
# still refuses, usually because it holds nothing but a single 256px PNG.
# Pull the largest frame out of it and rebuild properly from that.
$srcBytes = [System.IO.File]::ReadAllBytes($srcPath)
if ($srcBytes.Length -ge 4 -and $srcBytes[0] -eq 0 -and $srcBytes[1] -eq 0 -and
    $srcBytes[2] -eq 1 -and $srcBytes[3] -eq 0) {
    $iconStream = New-Object System.IO.MemoryStream(, $srcBytes)
    $icon = New-Object System.Drawing.Icon($iconStream, 256, 256)
    $image = $icon.ToBitmap()
    $icon.Dispose()
    $iconStream.Dispose()
} else {
    # Read through a stream, never FromFile: FromFile holds the handle open
    # and the destination is very often the source.
    $imgStream = New-Object System.IO.MemoryStream(, $srcBytes)
    $image = [System.Drawing.Image]::FromStream($imgStream)
}
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

$blob = New-Object "System.Collections.Generic.List[byte]"
Add-U16 $blob 0                              # reserved
Add-U16 $blob 1                              # type 1 = icon
Add-U16 $blob $images.Count

$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
    # 256 is written as 0: the field is one byte and 256 does not fit.
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
    $blob.Add([byte]$dim)                    # width
    $blob.Add([byte]$dim)                    # height
    $blob.Add([byte]0)                       # palette entries
    $blob.Add([byte]0)                       # reserved
    Add-U16 $blob 1                          # colour planes
    Add-U16 $blob 32                         # bits per pixel
    Add-U32 $blob $img.Bytes.Length
    Add-U32 $blob $offset
    $offset += $img.Bytes.Length
}
foreach ($img in $images) { $blob.AddRange($img.Bytes) }

$bytes = $blob.ToArray()

# Checked before it is allowed anywhere near the destination.
Test-IconBytes -Bytes $bytes

# Written beside the target and moved into place, so a failure leaves the
# previous icon untouched. File.Create truncates on open: the old code emptied
# a known-good icon before it knew whether it could produce a new one, and the
# csproj swallows this script's errors on purpose - which turned one bad run
# into a zero-byte icon and a build that failed on every attempt afterwards.
$temp = "$Destination.new"
[System.IO.File]::WriteAllBytes($temp, $bytes)
Move-Item -LiteralPath $temp -Destination $Destination -Force

$written = (Get-Item -LiteralPath $Destination).Length
$list = ($images | ForEach-Object { "{0}x{0}" -f $_.Size }) -join ", "
Write-Host ("  icon written: {0} ({1:N0} bytes, {2})" -f $Destination, $written, $list) -ForegroundColor Gray
