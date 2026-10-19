# Using your own SVG as the pet

DeskPal animates **any SVG**. Drop yours in via **Settings → Character → Choose SVG…**.
The whole drawing already breathes, walks along the Dock, hops when clicked, dangles when
dragged, squashes when it lands, and sleeps.

Name a few groups and it gets more expressive. Every part is optional.

| Give a group this `id` (or `data-part`) | What it does |
|---|---|
| `eyes` (or `eye-left` + `eye-right`) | blinks; closes while sleeping |
| any element with `class="pupil"` (or `id="pupils"`) | follows the mouse pointer |
| `mouth` | moves while the pet talks |
| `arm-left`, `arm-right` | swing while walking; the right arm waves hello |
| `antenna`, `tail` or `ears` | slow idle sway |
| `face` or `head` | tilts its head now and then |

## Pivot points

Each part rotates or scales around its own bounding box. To choose the pivot, add
`data-origin="x% y%"`. Two common cases:

```xml
<g id="arm-right" data-origin="15% 10%"> … </g>   <!-- shoulder at top-left of the arm -->
<g id="tail" data-origin="0% 100%"> … </g>        <!-- tail root at bottom-left -->
```

Defaults: arms pivot near the shoulder, sway parts at the bottom centre, everything else at the centre.

## Tips for a good result

- **Feet at the bottom of the viewBox.** The pet stands on the bottom edge of its box, so
  leave no empty space below the feet.
- **A roughly square viewBox** (e.g. `0 0 200 200`) looks best. Tall or wide drawings work too.
- **Draw the pet facing right.** It mirrors itself when it walks left.
- **Keep pupils inside the eyes, with ~4 units of room on every side.** They move up to 4.5
  units toward the pointer.
- **Outline text** (convert it to paths) in Figma or Illustrator. Fonts may not be installed.
- **Keep the file under 2 MB.**

## Exporting from Figma / Illustrator

1. Name your layers `eyes`, `mouth`, `arm-right` and so on, and group the pupils into a layer
   whose class or name is `pupil`.
2. **Figma:** select the frame → Export → SVG, and tick **“Include id attribute”**.
   **Illustrator:** File → Export As → SVG, and set Object IDs to **Layer Names**.
3. Check the result: Settings → Character lists the parts it found.

## What gets stripped (for safety)

Before an SVG is shown, these are removed: `<script>`, `<foreignObject>`, event handler
attributes (`onclick` and the like), and links to anything other than in-file `#ids` or
embedded `data:image/…`. Plain artwork is unaffected.

The bundled placeholder, `src/characters/default.svg`, is a working example of every part.
