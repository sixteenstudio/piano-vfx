# Piano Light-Bar VFX 💎🎹

A realtime **WebGPU** (Three.js) VFX overlay for piano playing. Your webcam is
the scene background; you mark where the keyboard is with a draggable marker on
every C key; and each key you play grows a **glassy, refracting, glowing cuboid**
out of itself — driven by **Web MIDI**. Hold a key and the bar extends (length =
note duration); release and it's cut off and dissolves.

Built in the style of a three.js example: a `lil-gui` control panel and an info
banner up top.

## Run it

```bash
npm install
npm run dev
```

Vite opens `http://localhost:5173`. Use **Chrome or Edge** — they have the best
WebGPU + Web MIDI support (it auto-falls back to WebGL2 if WebGPU is missing).
Grant **camera** access when prompted.

> Plug your MIDI piano into this machine over USB. It can be the *same* keyboard
> feeding your VST in another app — MIDI inputs can be read by multiple programs
> at once (on Windows you may need a virtual MIDI port / loopMIDI if a driver
> grabs the port exclusively).

## Using it

1. **Calibrate** — set your **Keyboard preset** (or low/high notes), then drag
   each **C** marker onto the centre of that C key. C is the white key
   immediately left of every pair of black keys; middle C (C4) is the blue one.
   Notes between two Cs are interpolated per octave, so the mapping follows the
   keyboard even under perspective/foreshortening.
2. **Pick your MIDI device** in the panel (auto-selected if only one). Your
   calibration is saved **per device name**, so switching instruments restores
   that instrument's marker positions automatically.
3. **Play.** Holding a key grows a bar from it (longer hold = longer bar, with
   **Infinite length** on by default). Releasing stops the growth — the bar then
   coasts off in the same direction at its frozen length and is culled once it
   leaves the camera. Harder hits make thicker bars. The sustain pedal keeps
   notes held — toggle that with **Sustain holds notes**.

### Direction & look

- **Effect → Direction (X / Y / Z)** — point the bars anywhere in 3D. `Z` toward
  you makes them pop out of the screen (perspective); `Y` sends them up, etc.
- **Shape & placement** — **Width** (thinner) and **Depth** (less deep) size the
  cross-section independently; **Roll** rotates each bar about its own length
  (how it faces); **Nudge X/Y/Z** offsets where bars originate.
- **Glow colour** / **Glass tint** — the subsurface glow colour and the tint
  applied to the refracted webcam.
- **Glow / Pulse speed / Pulse wave / Pulse floor** — the pulsating subsurface
  glow that travels along each bar.
- **Electrified outline** — a slow, silky energy flow along the bar's edges
  (colour, intensity, flow speed/detail, tightness).
- **Refraction / Glass glint / Glint sharpness** — how strongly the glass bends
  the webcam behind it and how bright its glassy edges are.
- **Grow / travel speed**, **Infinite length**, **Max length (if finite)** — bar
  growth & coast timing.

### Any camera angle

Because every C is placed by hand, mirror / back-to-front / angled setups are all
handled by *where you drop the markers*.

- **Mirror (left/right)** / **Flip (up/down)** — match how your webcam sees you.
- **Black-key setback** — how far black keys sit "back" from the white-key line.

### No piano yet?

Play your **computer keyboard**: `A W S E D F T G Y H U J K …` is a piano
octave-and-a-half (white keys on the home row, black keys above). `Z` / `X`
shift octaves. Or hit **Test bars (random)** in the panel.

## How it works

- **Webcam** is the WebGPU **scene background** (a `VideoTexture`, cover-fit +
  mirror/flip in-shader), so the glass bars can refract the live image.
- **Bars** are pooled `BoxGeometry` meshes sharing one TSL `MeshBasicNodeMaterial`
  rendered opaque (no transparency sorting). The "glass" is faked in screen
  space: it samples the webcam background with a normal-based offset
  (refraction), adds a fresnel rim, a pulsating subsurface glow core, and a slow
  silky electrified outline. Per-bar variety (pulse phase) is a *smooth* function
  of world position and per-bar intensity (velocity) is its thickness, so no
  per-mesh uniforms are needed.
- The box geometry's origin is its **near face** (local z ∈ [0,1]), so a growing
  bar only changes its z-scale, not its transform origin — that (plus the smooth,
  non-hashed phase) is what keeps the glow from flickering as bars grow/move.
- **Camera** is perspective; bars spawn on the `z=0` plane (the calibrated key
  position unprojected onto it), extend along the chosen 3D direction while held
  (near face glued to the key), then translate rigidly along it after release
  until the near→far segment falls outside the view frustum.
