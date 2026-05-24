# Piano Flame VFX 🔥🎹

A realtime **WebGPU** (Three.js) VFX overlay for piano playing. It shows your
webcam, lets you mark where the keyboard is with two draggable points, and
shoots a flame out of each key as you play it — driven by **Web MIDI**.

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
2. **Pick your MIDI device** in the panel (auto-selected if only one).
3. **Play.** Flames erupt from each key; harder hits burn brighter. The sustain
   pedal keeps them lit.

### Any camera angle

Because every C is placed by hand, mirror / back-to-front / angled setups are all
handled by *where you drop the markers*. The remaining controls:

- **Mirror (left/right)** / **Flip (up/down)** — match how your webcam sees you
  (these flip the video image only).
- **Flip flame side** — shoot the flames out the other edge of the keyboard.
- **Black-key setback** — how far black keys sit "back" from the white-key line.

Marker positions + flame settings are saved to `localStorage`, so they survive a
reload (and per-note, so changing keyboard size keeps the Cs you already placed).

### No piano yet?

Play your **computer keyboard**: `A W S E D F T G Y H U J K …` is a piano
octave-and-a-half (white keys on the home row, black keys above). `Z` / `X`
shift octaves. Or hit **Test flame (random)** in the panel.

## How it works

- **Webcam** is a CSS `<video>` background; the WebGPU canvas sits on top with
  `mix-blend-mode: screen`, so additive flame light glows onto the live image
  with no extra compositing.
- **Flames** are GPU-instanced quads rendered through a TSL node material
  (`MeshBasicNodeMaterial` + additive blending). The particle sim runs on the
  CPU — a few thousand particles is cheap and keeps spawning trivial.
- **Camera** is orthographic with world units == CSS pixels (y-up), so handle
  positions map straight to flame emit points.

Tweak the look live under the **Flame** folder (emission rate, speed, buoyancy,
turbulence, size, brightness, warmth).
