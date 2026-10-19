# Shyam — DeskPal companion character

A desktop companion drawn from your beach photo (bucket hat, blue-striped camp shirt,
shoulder bag, light shorts), rigged for the character engine already in `focuscat-clone`.

## The one file that matters

`svg/shyam-rigged.svg` — already copied into the project as
`src/characters/shyam.svg`. Pick it in the app under **Settings → Character → Choose SVG…**

The engine (`src/lib/character.js`) animates named parts, so there is no sprite sheet and
no frame swapping. Parts it finds in this file:

| Part | What the engine does with it |
|---|---|
| `face` | tilts its head now and then |
| `eyes`, `eye-left`, `eye-right` | blinks; closes while sleeping |
| `class="pupil"` (×2) | follows the mouse pointer |
| `mouth` | moves while the pet talks |
| `arm-left`, `arm-right` | swing while walking; the right arm waves hello |
| `data-part="tail"` | the shoulder bag — slow idle sway |
| `body`, `feet` | ride the walk, hop and landing squash |

Two details the engine forced:

- **No `transform` attribute on a named part.** `character.js` writes
  `element.style.transform`, which overrides the attribute, so every pose transform sits on a
  plain inner `<g>`. Add a transform to `#arm-left` and the arm jumps on first animation.
- **Pupils move a fixed ±4.5 user units.** In a 512 box that is invisible, so each pupil sits
  inside a `scale(1.8)` group — 4.5 local units become 8.1 units of the drawing, which keeps a
  9-unit pupil inside its 19-unit sclera.

Feet sit on the bottom edge of the viewBox, as `docs/CHARACTER_SVG.md` requires.

### Making him the default

Point the loader at `characters/shyam.svg` where it currently reads
`characters/default.svg`.

## Extra poses

Not needed by the engine — it poses the rigged file itself. These are for the README, a
landing page, or anywhere a still is useful.

```
svg/shyam-idle.svg        standing around
svg/shyam-focus.svg       head down on the laptop
svg/shyam-break.svg       chai in hand
svg/shyam-sleep.svg       dozing, zzz
svg/shyam-celebrate.svg   arms up, confetti
png/shyam-<pose>-{512,256,128,64}.png
png/shyam-spritesheet-256.png     1280×256, five frames in the order above
```

96 px is a sensible floor for an always-on window; below 64 px the glasses and beard merge
into the face.

## Regenerating

`gen.py` has an `OUTFIT` switch at the top: `"beach"` is the current look, `"office"` swaps in
the white striped shirt, dhoti and lanyard from the first photo. Colour constants
(`SHIRT_BLUE`, `SHIRT_NAVY`, `SHORTS`, `HAT`, `SKIN`…) sit beside it.

```bash
pip install cairosvg
python3 gen.py              # the five poses -> svg/
python3 gen_rigged.py       # the rigged character -> svg/shyam-rigged.svg
python3 - <<'PY'
import cairosvg
for s in ['idle','focus','break','sleep','celebrate']:
    for z in (512,256,128,64):
        cairosvg.svg2png(url=f'svg/shyam-{s}.svg',
                         write_to=f'png/shyam-{s}-{z}.png',
                         output_width=z, output_height=z)
PY
```

One caveat if you move the SVG around by other means: a copy of it picked up a C2PA
provenance block in `<metadata>` during transfer. It is harmless (the engine's sanitiser
leaves it, and it doesn't render) but it tripled the file size — the copy in the project has
been stripped back to 9 KB.
