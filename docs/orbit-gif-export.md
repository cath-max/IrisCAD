# README orbit GIF tool (development only)

Start IrisCAD with `npm run dev:local` (or `npm run dev` if its services are
already running), then open or build a model in the editor. The preview's upper
right corner shows **README GIF · DEV**. Choose a filename and click **Export
orbit GIF**. The initial filename uses the selected model's title, for example
`centrifugal-pump-impeller-orbit.gif`. You can override it; edits are retained
while that preview remains selected. The panel sits below the Export control.

Enable **同时下载对照 PNG（第一帧）** to also download `*-frame-001.png`.
This is the exact first frame after resizing and background compositing, before
GIF palette quantization; it needs no additional model render. Compare it with
the GIF's first frame at the same display size to investigate color banding.
If the browser blocks the second automatic download, click **重新下载对照 PNG**.

The tool downloads a 520 × 520 GIF with 36 frames, a 1.5-second cycle and infinite
looping. It uses currently visible model components. The orbit starts at the
current camera's azimuth, with the camera 28 degrees above the horizon, and fits
the model across all orbit angles. The output has a solid `#f2f2f4` background.

The DEV panel renders at 1040 × 1040 and downsamples to 520 × 520 (2×
supersampling). Model framing defaults to 92% (previously 80%), adjustable
from 75% to 96% in the panel. Framing uses one fixed scale that accommodates
the entire orbit; an end-on view of a long model will still appear narrower.
The margin covers model geometry, not necessarily the full shadow extent.
The shared animation palette is built with full 8-bit RGB
histogram values and weighted median-cut; nearest-color matching also uses
full RGB keys. This avoids the extra RGB565 binning that merged adjacent gray
shades. GIF still has a maximum of 256 palette colors across the animation.

During export the preview loop and controls pause. Rendering and encoding
progress appear in the panel. Completion and failure restore the preview;
leaving the page cancels the export at the next progress boundary. Keep the
model unchanged during export. This tool does not regenerate CAD or meshes.

The renderer needs WebGL2 and `EXT_color_buffer_float`. Each GIF frame uses one
model render and one fullscreen color-conversion pass to preserve Three.js
r160 tone mapping. The latter is an intentional addition to the original
handoff's single-render-per-frame plan. The normal preview scene is reused;
the camera is cloned and the gizmo HUD is not rendered into the GIF.

Production builds remove the DEV entry and its dynamic imports. To verify:

```sh
npm run test:orbit-gif
npm run typecheck
npm run lint
npm run build
node scripts/check-orbit-gif-production.mjs
```

Automated tests use a controlled renderer and real Three.js cameras/objects.
Actual wastebasket/bicycle exports, visual inspection, file-size measurement,
and README insertion remain the handoff's Steps 9–10.
