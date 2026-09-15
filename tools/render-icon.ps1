Add-Type -AssemblyName System.Drawing
$D2 = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# The same geometry as brand/iydani-mark.svg, in artwork coordinates.
function New-InkPath {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    # left key: top edge, top-left corner, left side, bottom-left corner, base
    $p.StartFigure()
    $p.AddLine(248.0, 19.25, 48.0, 19.25)
    $p.AddArc(-9.5, 19.25, 57.5, 57.5, 270, -90)      # centre (19.25+28.75, 48)
    $p.AddLine(19.25, 48.0, 19.25, 464.5)
    $p.AddArc(-9.5, 435.75, 57.5, 57.5, 180, -90)
    $p.AddLine(48.0, 493.25, 205.0, 493.25)
    return $p
}
function New-InkPath2 {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.StartFigure()
    $p.AddLine(281.0, 19.25, 339.5, 19.25)
    $p.AddArc(310.75, 19.25, 57.5, 57.5, 270, 90)
    $p.AddLine(368.25, 48.0, 368.25, 464.5)
    $p.AddArc(310.75, 435.75, 57.5, 57.5, 0, 90)
    $p.AddLine(339.5, 493.25, 238.0, 493.25)
    return $p
}
function New-KeyPath {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddLine(139.0, 8.0, 248.0, 8.0)
    $p.AddLine(248.0, 8.0, 248.0, 334.5)
    $p.AddArc(224.0, 322.5, 24.0, 24.0, 0, 90)
    $p.AddLine(236.0, 346.5, 205.0, 346.5)
    $p.AddLine(205.0, 346.5, 205.0, 504.5)
    $p.AddLine(205.0, 504.5, 182.0, 504.5)
    $p.AddLine(182.0, 504.5, 182.0, 346.5)
    $p.AddLine(182.0, 346.5, 151.0, 346.5)
    $p.AddArc(139.0, 322.5, 24.0, 24.0, 90, 90)
    $p.CloseFigure()
    return $p
}

# Renders the mark into a bitmap of the given size. `plate` paints the key
# faces; without it you get the ink alone, which is what the geometry check
# compares against the source PNG's mask.
function Render-Mark([int]$size, [int]$pad, [bool]$plate) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = $D2
    $g.Clear([System.Drawing.Color]::Transparent)
    $box = $size - $pad * 2
    $s = [Math]::Min($box / 371.5, $box / 496.5)
    $g.TranslateTransform([single](($size - 371.5 * $s) / 2 - 8 * $s), [single](($size - 496.5 * $s) / 2 - 8 * $s))
    $g.ScaleTransform([single]$s, [single]$s)
    if ($plate) {
        $face = New-Object System.Drawing.Drawing2D.GraphicsPath
        $r = 78.0
        $face.AddArc(9.0, 9.0, $r, $r, 180, 90)
        $face.AddArc(378.5 - $r, 9.0, $r, $r, 270, 90)
        $face.AddArc(378.5 - $r, 503.5 - $r, $r, $r, 0, 90)
        $face.AddArc(9.0, 503.5 - $r, $r, $r, 90, 90)
        $face.CloseFigure()
        $g.FillPath([System.Drawing.Brushes]::White, $face)
        $face.Dispose()
    }
    $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 17, 17, 17))
    $pen = New-Object System.Drawing.Pen $ink, ([single]22.5)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Flat
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Flat
    foreach ($f in @((New-InkPath), (New-InkPath2))) { $g.DrawPath($pen, $f); $f.Dispose() }
    $k = New-KeyPath; $g.FillPath($ink, $k); $k.Dispose()
    $pen.Dispose(); $ink.Dispose(); $g.Dispose()
    return $bmp
}

# --- entry point -------------------------------------------------------------
#
# Regenerates the raster app icon from the geometry above, which is the same
# geometry as src/renderer/brand/iydani-mark.svg. Change one and change the
# other: the SVG is what the UI draws, this is what the taskbar gets.
#
#   powershell -File tools/render-icon.ps1
#
$root = Split-Path -Parent $PSScriptRoot
$icon = Render-Mark 512 44 $true
foreach ($p in @("$root\build\icon.png", "$root\src\renderer\brand\iydani-icon.png")) {
    $dir = Split-Path -Parent $p
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $icon.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
    "wrote $p"
}
$icon.Dispose()
