Brand artwork.

assets/IYDANI.jpeg (2560x2560) is the SOURCE OF RECORD.

  iydani-mark.svg    the monogram, DRAWN — hand-built vector, not a cut-out
  iydani-lockup.png  926x1024 — monogram + IYDANI + the SCORER pill, for About
  iydani-icon.png    512x512 — the app icon, a rasterisation of the SVG

THE MARK IS DRAWN, NOT TRACED. Every number in iydani-mark.svg was measured off
the JPEG at 388x512 and is the geometry the logo was originally built from: an
outer box x 8..379.5 / y 8..504.5 with corner radius 40, a 22.5-wide frame
stroke (centreline radius 40 - 22.5/2 = 28.75), a black key x 139..248 running
from the outer top down to y 346.5 with 12-radius bottom corners, a stem
x 182..205, and two 33-wide gaps at 248..281 and 205..238. Rendered back
against the source it lands at 94% IoU, the balance being antialiased edge.

Because it is a drawing it has NO BACKGROUND: the white belongs to the key
faces, so the corners are round and the art sits on whatever is behind it
rather than on a rectangular tile. The faces must be painted rather than left
clear — the black key has to read darker than the keys beside it, and it
cannot do that if they are transparent over dark chrome. The white plate is
inset 1 unit so its antialiased edge stays under the frame stroke.

NOTHING here is ever inverted for dark theme. The monogram is a keyboard, and
the moment its two colours become one the keyboard stops being legible; the
lockup would lose its yellow pill to blue. The lockup is shown on its own light
card in the About box instead, the same exemption the printed sheet's emblem
has.

The lockup is still keyed out of the JPEG rather than drawn — the wordmark is
set in a specific typeface, so redrawing it would be a different logo.

To regenerate the icon after changing the SVG:  powershell -File tools/render-icon.ps1
It carries the same geometry; change one and change the other. Give the icon a
NEW FILENAME if you replace it — Windows caches window icons by path and will
go on serving the old one across fresh launches.
