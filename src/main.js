import * as THREE from 'three/webgpu';
import GUI from 'lil-gui';

import { FlameSystem } from './flames.js';
import { Calibration } from './calibration.js';
import { Webcam } from './webcam.js';
import { MidiInput, KeyboardInput } from './midi.js';

const statusEl = document.getElementById('status');
const fatalEl = document.getElementById('fatal');

function setStatus(msg) {
	statusEl.textContent = msg;
}
function fatal(html) {
	fatalEl.hidden = false;
	fatalEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Scene / renderer (orthographic, world units == CSS pixels, y-up)
// ---------------------------------------------------------------------------
let renderer, scene, camera, flames, calibration, webcam, gui;

const emitters = new Map(); // note -> { velocity, until? }
const clock = new THREE.Clock();

async function init() {
	if (!('gpu' in navigator)) {
		setStatus('No WebGPU — falling back to WebGL2. (Chrome/Edge give the best results.)');
	}

	renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setClearColor(0x000000, 1);

	try {
		await renderer.init();
	} catch (err) {
		fatal(
			`<div><h2>Couldn't start the GPU renderer</h2>
			<p>${String(err)}</p>
			<p>This overlay needs WebGPU (best) or WebGL2. Try a recent
			<a href="https://www.google.com/chrome/">Chrome</a> or Edge.</p></div>`,
		);
		return;
	}

	document.body.appendChild(renderer.domElement);

	scene = new THREE.Scene();
	camera = new THREE.OrthographicCamera(
		-window.innerWidth / 2,
		window.innerWidth / 2,
		window.innerHeight / 2,
		-window.innerHeight / 2,
		0.1,
		1000,
	);
	camera.position.z = 10;

	flames = new FlameSystem();
	scene.add(flames.mesh);

	calibration = new Calibration();
	calibration.setGuidesVisible(calibration.opts.showGuides);

	// ---- input ----
	const onNoteOn = (note, velocity) => emitters.set(note, { velocity });
	const onNoteOff = (note) => {
		const e = emitters.get(note);
		if (e && !e.until) emitters.delete(note); // leave timed test bursts alone
	};

	webcam = new Webcam(document.getElementById('webcam'));
	const midi = new MidiInput({
		onNoteOn,
		onNoteOff,
		onDevices: (list) => refreshMidiOptions(list),
		onStatus: setStatus,
	});
	new KeyboardInput({ onNoteOn, onNoteOff });

	// ---- webcam start ----
	try {
		await webcam.start();
	} catch (err) {
		setStatus(`Camera unavailable (${err.name || err}). Flames still work — grant camera access and reload for the overlay.`);
	}

	await midi.init();

	buildGUI(midi);

	window.addEventListener('resize', onResize);
	renderer.setAnimationLoop(animate);

	const backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
	if (!statusEl.textContent) setStatus(`Running on ${backend}. Calibrate the handles and play!`);
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
	if (list.length && !list.some((d) => d.id === midiProxy.device)) {
		midiProxy.device = list[0].id;
	}
	midiCtrl = midiCtrl.options(options);
	midiCtrl.onChange(midiHandler);
	midiCtrl.updateDisplay();
}

function buildGUI(midi) {
	gui = new GUI({ title: '🔥 Piano Flame VFX' });

	// ---- MIDI ----
	const fMidi = gui.addFolder('MIDI');
	midiHandler = (id) => midi.select(id);
	midiCtrl = fMidi.add(midiProxy, 'device', { '— none —': '' }).name('Input device');
	midiCtrl.onChange(midiHandler);
	fMidi.add({ rescan: () => midi.refresh() }, 'rescan').name('Rescan devices');
	refreshMidiOptions(midi.listInputs());

	// ---- Webcam ----
	const fCam = gui.addFolder('Webcam');
	fCam.add(webcam, 'flipX').name('Mirror (left/right)').onChange(() => webcam.applyTransform());
	fCam.add(webcam, 'flipY').name('Flip (up/down)').onChange(() => webcam.applyTransform());
	const camProxy = { device: '' };
	let camCtrl = fCam.add(camProxy, 'device', { Default: '' }).name('Camera');
	camCtrl.onChange((id) => webcam.start(id).catch((e) => setStatus(String(e))));
	webcam.listCameras().then((cams) => {
		if (!cams.length) return;
		const opts = {};
		for (const c of cams) opts[c.label] = c.id;
		camCtrl = camCtrl.options(opts);
		camCtrl.onChange((id) => webcam.start(id).catch((e) => setStatus(String(e))));
	});

	// ---- Calibration ----
	const fCal = gui.addFolder('Calibration');
	const applyRange = () =>
		calibration.setRange(calibration.opts.lowNote, calibration.opts.highNote);
	fCal.add(calibration.opts, 'lowNote', 0, 127, 1).name('Lowest key (MIDI)').onChange(applyRange);
	fCal.add(calibration.opts, 'highNote', 0, 127, 1).name('Highest key (MIDI)').onChange(applyRange);
	fCal
		.add(calibration.opts, 'flameSide')
		.name('Flip flame side')
		.onChange(() => {
			calibration.render();
			calibration.save();
		});
	fCal
		.add(calibration.opts, 'blackKeyDepth', -1, 1, 0.05)
		.name('Black-key setback')
		.onChange(() => calibration.save());
	fCal
		.add(calibration.opts, 'showGuides')
		.name('Show calibration guides')
		.onChange((v) => calibration.setGuidesVisible(v));
	fCal.add({ reset: () => calibration.resetHandles() }, 'reset').name('Reset C markers');

	// presets for common keyboards
	const presets = {
		'88 keys (A0–C8)': [21, 108],
		'76 keys (E1–G7)': [28, 103],
		'61 keys (C2–C7)': [36, 96],
		'49 keys (C2–C6)': [36, 84],
		'25 keys (C3–C5)': [48, 72],
	};
	const presetProxy = { size: '88 keys (A0–C8)' };
	fCal
		.add(presetProxy, 'size', Object.keys(presets))
		.name('Keyboard preset')
		.onChange((k) => {
			const [lo, hi] = presets[k];
			calibration.setRange(lo, hi);
			fCal.controllersRecursive().forEach((c) => c.updateDisplay());
		});

	// ---- Flame look ----
	const p = flames.params;
	const fFlame = gui.addFolder('Flame');
	fFlame.add(p, 'emitRate', 10, 300, 1).name('Emission rate');
	fFlame.add(p, 'speed', 40, 600, 1).name('Launch speed');
	fFlame.add(p, 'spread', 0, 200, 1).name('Spread');
	fFlame.add(p, 'buoyancy', 0, 500, 1).name('Buoyancy');
	fFlame.add(p, 'turbulence', 0, 400, 1).name('Turbulence');
	fFlame.add(p, 'lifetime', 0.2, 2.5, 0.05).name('Lifetime (s)');
	fFlame.add(p, 'sizeBase', 8, 120, 1).name('Flame size').onChange(() => flames.syncUniforms());
	fFlame.add(p, 'brightness', 0.2, 3, 0.05).name('Brightness').onChange(() => flames.syncUniforms());
	fFlame.add(p, 'warmth', 0.3, 2, 0.05).name('Warmth').onChange(() => flames.syncUniforms());

	// ---- Actions ----
	gui.add({ test: testBurst }, 'test').name('🎆 Test flame (random)');
	gui.add({ panic: () => { emitters.clear(); flames.clear(); } }, 'panic').name('Clear all flames');
}

// fire a handful of timed bursts across the keyboard to preview the look
function testBurst() {
	const { lowNote, highNote } = calibration.opts;
	const until = clock.elapsedTime + 0.3;
	for (let k = 0; k < 4; k++) {
		const note = Math.round(lowNote + Math.random() * (highNote - lowNote));
		emitters.set(note, { velocity: 0.6 + Math.random() * 0.4, until });
	}
}

// ---------------------------------------------------------------------------
function onResize() {
	const w = window.innerWidth;
	const h = window.innerHeight;
	camera.left = -w / 2;
	camera.right = w / 2;
	camera.top = h / 2;
	camera.bottom = -h / 2;
	camera.updateProjectionMatrix();
	renderer.setSize(w, h);
	calibration.resize();
}

function animate() {
	const dt = Math.min(clock.getDelta(), 0.05); // clamp big tab-switch gaps
	const time = clock.elapsedTime;

	// flame launch/wobble directions follow the live keyboard line
	flames.flameDir = calibration.flameDir;
	flames.lineDir = calibration.lineDir;

	// emit from every held note
	for (const [note, e] of emitters) {
		if (e.until !== undefined && time > e.until) {
			emitters.delete(note);
			continue;
		}
		const pos = calibration.notePosition(note);
		e.accum = (e.accum || 0) + flames.params.emitRate * (0.35 + e.velocity) * dt;
		let n = Math.floor(e.accum);
		e.accum -= n;
		while (n-- > 0) flames.spawn(pos.x, pos.y, e.velocity);
	}

	flames.update(dt, time);
	renderer.render(scene, camera);
}

init();
