import * as THREE from 'three/webgpu';
import { texture, screenUV, uniform } from 'three/tsl';
import GUI from 'lil-gui';

import { BarSystem } from './bars.js';
import { Calibration } from './calibration.js';
import { Webcam } from './webcam.js';
import { MidiInput, KeyboardInput } from './midi.js';

const statusEl = document.getElementById('status');
const fatalEl = document.getElementById('fatal');
const setStatus = (msg) => (statusEl.textContent = msg);
const fatal = (html) => {
	fatalEl.hidden = false;
	fatalEl.innerHTML = html;
};

// ---------------------------------------------------------------------------
// Perspective 3D scene. The webcam is the scene background (so glass bars can
// refract it); bars spawn on the z=0 plane and extend in true 3D toward camera.
// ---------------------------------------------------------------------------
const CAM_Z = 6;
let renderer, scene, camera, bars, calibration, webcam, videoEl, videoTex;
let coverScale; // uniform(vec2) — cover-fit + mirror/flip of the webcam
let fCal; // calibration GUI folder (refreshed on device switch)

const raycaster = new THREE.Raycaster();
const planeZ0 = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const clock = new THREE.Clock();

async function init() {
	if (!('gpu' in navigator)) {
		setStatus('No WebGPU — falling back to WebGL2. (Chrome/Edge give the best results.)');
	}

	renderer = new THREE.WebGPURenderer({ antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setClearColor(0x05070a, 1);

	try {
		await renderer.init();
	} catch (err) {
		fatal(`<div><h2>Couldn't start the GPU renderer</h2><p>${String(err)}</p>
			<p>This overlay needs WebGPU (best) or WebGL2 — try a recent
			<a href="https://www.google.com/chrome/">Chrome</a> or Edge.</p></div>`);
		return;
	}
	document.body.appendChild(renderer.domElement);

	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
	camera.position.z = CAM_Z;
	camera.lookAt(0, 0, 0);

	// ---- webcam as a refractable background ----
	videoEl = document.getElementById('webcam');
	webcam = new Webcam(videoEl);
	videoTex = new THREE.VideoTexture(videoEl);
	videoTex.colorSpace = THREE.SRGBColorSpace;
	coverScale = uniform(new THREE.Vector2(1, 1));
	scene.backgroundNode = texture(videoTex, screenUV.sub(0.5).mul(coverScale).add(0.5));

	bars = new BarSystem({ videoTexture: videoTex, coverScale });
	scene.add(bars.group);

	calibration = new Calibration();
	calibration.setGuidesVisible(calibration.opts.showGuides);

	// ---- input → bars ----
	const onNoteOn = (note, vel) => {
		const s = calibration.noteScreen(note);
		const base = screenToWorld(s.x, s.y);
		if (base) bars.spawn(note, base, vel);
	};
	const onNoteOff = (note) => bars.release(note);

	const midi = new MidiInput({
		onNoteOn,
		onNoteOff,
		onDevices: (list) => refreshMidiOptions(list),
		onStatus: setStatus,
		onSelect: (name) => {
			calibration.setDevice(name);
			fCal?.controllersRecursive().forEach((c) => c.updateDisplay());
		},
	});
	new KeyboardInput({ onNoteOn, onNoteOff });

	// ---- webcam start ----
	try {
		await webcam.start();
	} catch (err) {
		setStatus(`Camera unavailable (${err.name || err}). Bars still work — grant camera access and reload for the overlay.`);
	}
	updateCover();
	videoEl.addEventListener('loadedmetadata', updateCover);

	await midi.init();
	buildGUI(midi);

	window.addEventListener('resize', onResize);
	renderer.setAnimationLoop(animate);

	const backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
	if (!statusEl.textContent) setStatus(`Running on ${backend}. Calibrate the C markers and play!`);
}

/** client px → world point on the z=0 plane (where bar bases live) */
function screenToWorld(clientX, clientY) {
	const ndc = new THREE.Vector2(
		(clientX / window.innerWidth) * 2 - 1,
		-((clientY / window.innerHeight) * 2 - 1),
	);
	raycaster.setFromCamera(ndc, camera);
	const out = new THREE.Vector3();
	return raycaster.ray.intersectPlane(planeZ0, out) ? out : null;
}

/** recompute the webcam cover-fit + mirror/flip into the shared uniform */
function updateCover() {
	const vw = videoEl.videoWidth || 16;
	const vh = videoEl.videoHeight || 9;
	const va = vw / vh;
	const sa = window.innerWidth / window.innerHeight;
	let sx = 1;
	let sy = 1;
	if (sa > va) sy = va / sa; // screen wider → crop top/bottom
	else sx = sa / va; // screen taller → crop sides
	if (webcam.flipX) sx = -sx;
	if (webcam.flipY) sy = -sy;
	coverScale.value.set(sx, sy);
}

// ---------------------------------------------------------------------------
// GUI
// ---------------------------------------------------------------------------
let midiCtrl;
let midiHandler = () => {};
const midiProxy = { device: '' };

function refreshMidiOptions(list) {
	if (!midiCtrl) return;
	const options = { '— none —': '' };
	for (const d of list) options[d.name] = d.id;
	if (list.length && !list.some((d) => d.id === midiProxy.device)) midiProxy.device = list[0].id;
	midiCtrl = midiCtrl.options(options);
	midiCtrl.onChange(midiHandler);
	midiCtrl.updateDisplay();
}

function buildGUI(midi) {
	const gui = new GUI({ title: '💎 Piano Light-Bar VFX' });

	// ---- MIDI ----
	const fMidi = gui.addFolder('MIDI');
	midiHandler = (id) => midi.select(id);
	midiCtrl = fMidi.add(midiProxy, 'device', { '— none —': '' }).name('Input device');
	midiCtrl.onChange(midiHandler);
	fMidi.add({ rescan: () => midi.refresh() }, 'rescan').name('Rescan devices');
	fMidi.add(midi, 'sustainHolds').name('Sustain holds notes');
	refreshMidiOptions(midi.listInputs());

	// ---- Webcam ----
	const fCam = gui.addFolder('Webcam');
	fCam.add(webcam, 'flipX').name('Mirror (left/right)').onChange(updateCover);
	fCam.add(webcam, 'flipY').name('Flip (up/down)').onChange(updateCover);
	const camProxy = { device: '' };
	let camCtrl = fCam.add(camProxy, 'device', { Default: '' }).name('Camera');
	const camSwitch = (id) => webcam.start(id).then(updateCover).catch((e) => setStatus(String(e)));
	camCtrl.onChange(camSwitch);
	webcam.listCameras().then((cams) => {
		if (!cams.length) return;
		const opts = {};
		for (const c of cams) opts[c.label] = c.id;
		camCtrl = camCtrl.options(opts);
		camCtrl.onChange(camSwitch);
	});

	// ---- Calibration ----
	fCal = gui.addFolder('Calibration');
	const applyRange = () => calibration.setRange(calibration.opts.lowNote, calibration.opts.highNote);
	fCal.add(calibration.opts, 'lowNote', 0, 127, 1).name('Lowest key (MIDI)').onChange(applyRange);
	fCal.add(calibration.opts, 'highNote', 0, 127, 1).name('Highest key (MIDI)').onChange(applyRange);
	fCal.add(calibration.opts, 'blackKeyDepth', -1, 1, 0.05).name('Black-key setback').onChange(() => calibration.save());
	fCal.add(calibration.opts, 'showGuides').name('Show calibration guides').onChange((v) => calibration.setGuidesVisible(v));
	fCal.add({ reset: () => calibration.resetHandles() }, 'reset').name('Reset C markers');
	const presets = {
		'88 keys (A0–C8)': [21, 108],
		'76 keys (E1–G7)': [28, 103],
		'61 keys (C2–C7)': [36, 96],
		'49 keys (C2–C6)': [36, 84],
		'25 keys (C3–C5)': [48, 72],
	};
	fCal
		.add({ size: '88 keys (A0–C8)' }, 'size', Object.keys(presets))
		.name('Keyboard preset')
		.onChange((k) => {
			const [lo, hi] = presets[k];
			calibration.setRange(lo, hi);
			fCal.controllersRecursive().forEach((c) => c.updateDisplay());
		});

	// ---- Effect (glass bars) ----
	const p = bars.params;
	const sync = () => bars.syncUniforms();
	const fx = gui.addFolder('Effect — glass bars');
	fx.addColor(p, 'color').name('Glow colour').onChange(sync);
	fx.addColor(p, 'tint').name('Glass tint').onChange(sync);
	fx.add(p, 'glow', 0, 2, 0.01).name('Glow intensity').onChange(sync);
	fx.add(p, 'glowFloor', 0, 1, 0.01).name('Pulse floor').onChange(sync);
	fx.add(p, 'pulseSpeed', 0, 12, 0.1).name('Pulse speed').onChange(sync);
	fx.add(p, 'pulseWave', 0, 6, 0.1).name('Pulse wave').onChange(sync);
	fx.add(p, 'refraction', 0, 0.3, 0.005).name('Refraction').onChange(sync);
	fx.add(p, 'fresnel', 0, 3, 0.05).name('Glass glint').onChange(sync);
	fx.add(p, 'fresnelPow', 0.5, 6, 0.1).name('Glint sharpness').onChange(sync);
	fx.add(p, 'extendSpeed', 0.2, 14, 0.1).name('Grow / travel speed');
	fx.add(p, 'infiniteLength').name('Infinite length');
	fx.add(p, 'maxLength', 0.5, 30, 0.1).name('Max length (if finite)');

	// ---- Shape & placement ----
	const fShape = fx.addFolder('Shape & placement');
	fShape.add(p, 'width', 0.01, 1.2, 0.01).name('Width (thinner ↓)');
	fShape.add(p, 'depth', 0.01, 1.2, 0.01).name('Depth (less deep ↓)');
	fShape.add(p, 'roll', -180, 180, 1).name('Roll / facing (°)');
	fShape.add(p, 'nudgeX', -3, 3, 0.02).name('Nudge X');
	fShape.add(p, 'nudgeY', -3, 3, 0.02).name('Nudge Y');
	fShape.add(p, 'nudgeZ', -3, 3, 0.02).name('Nudge Z');

	// ---- Direction (extend anywhere in 3D) ----
	const fDir = fx.addFolder('Direction');
	fDir.add(p, 'dirX', -1, 1, 0.01).name('X (left/right)');
	fDir.add(p, 'dirY', -1, 1, 0.01).name('Y (down/up)');
	fDir.add(p, 'dirZ', -1, 1, 0.01).name('Z (away/toward you)');

	// ---- Electrified outline ----
	const fArc = fx.addFolder('Electrified outline');
	fArc.addColor(p, 'arcColor').name('Outline colour').onChange(sync);
	fArc.add(p, 'arc', 0, 3, 0.05).name('Intensity').onChange(sync);
	fArc.add(p, 'arcSpeed', 0, 4, 0.05).name('Flow speed').onChange(sync);
	fArc.add(p, 'arcFreq', 0.5, 14, 0.1).name('Flow detail').onChange(sync);
	fArc.add(p, 'edgeSharp', 0.5, 8, 0.1).name('Outline tightness').onChange(sync);

	// ---- Actions ----
	gui.add({ test: testBurst }, 'test').name('💎 Test bars (random)');
	gui.add({ clear: () => bars.clear() }, 'clear').name('Clear all bars');
}

function testBurst() {
	const { lowNote, highNote } = calibration.opts;
	for (let k = 0; k < 3; k++) {
		const note = Math.round(lowNote + Math.random() * (highNote - lowNote));
		const s = calibration.noteScreen(note);
		const base = screenToWorld(s.x, s.y);
		if (!base) continue;
		bars.spawn(note, base, 0.7 + Math.random() * 0.3);
		setTimeout(() => bars.release(note), 350 + Math.random() * 500);
	}
}

// ---------------------------------------------------------------------------
function onResize() {
	const w = window.innerWidth;
	const h = window.innerHeight;
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	renderer.setSize(w, h);
	calibration.resize();
	updateCover();
}

function animate() {
	const dt = Math.min(clock.getDelta(), 0.05);
	if (videoEl.readyState >= videoEl.HAVE_CURRENT_DATA) videoTex.needsUpdate = true;
	bars.update(dt, camera);
	renderer.render(scene, camera);
}

init();
