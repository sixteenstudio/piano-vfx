/**
 * Multi-point keyboard calibration.
 *
 * The user drags one marker onto the centre of every C key they can see
 * (C is the white key immediately left of each pair of black keys). Notes
 * between two C markers are interpolated *per octave segment* using real piano
 * geometry, so the mapping follows the keyboard even when perspective /
 * foreshortening compresses the far end.
 *
 * Output is `noteScreen(note)` in CSS/client pixels (origin top-left). main.js
 * unprojects that onto the z=0 plane to get the 3D point a note's effect spawns
 * from.
 *
 * Marker positions + the keyboard range are stored *per MIDI device name*, so
 * switching instruments restores that instrument's calibration instead of
 * forcing a re-calibrate. (Global look prefs like guide visibility live under a
 * shared key.)
 */
const STORE_KEY = 'piano-vfx-calibration-v3';
const DEFAULT_DEVICE = '__default__';

export class Calibration {
	constructor(onChange) {
		this.onChange = onChange || (() => {});
		this.w = window.innerWidth;
		this.h = window.innerHeight;

		this.opts = {
			lowNote: 21, // A0  (88-key piano = 21..108)
			highNote: 108, // C8
			showGuides: true,
			blackKeyDepth: 0.35, // how far black keys sit "back" (in white-key widths)
		};

		this.markers = {}; // note -> {x,y} client px (for the current device)
		this.deviceKey = DEFAULT_DEVICE;

		this._load();

		this.container = document.getElementById('calibration');
		this.poly = document.getElementById('cal-poly');
		this.handleEls = {}; // note -> element

		this.setDevice(DEFAULT_DEVICE);
	}

	_load() {
		try {
			this.store = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
		} catch {
			this.store = {};
		}
		if (!this.store.devices) this.store.devices = {};
		if (this.store.global) Object.assign(this.opts, this.store.global);
	}

	_save() {
		this.store.devices[this.deviceKey] = {
			markers: this.markers,
			lowNote: this.opts.lowNote,
			highNote: this.opts.highNote,
		};
		this.store.global = {
			showGuides: this.opts.showGuides,
			blackKeyDepth: this.opts.blackKeyDepth,
		};
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(this.store));
		} catch {
			/* ignore */
		}
	}

	/** Switch to a device's saved calibration (markers + range), or defaults. */
	setDevice(name) {
		this.deviceKey = name || DEFAULT_DEVICE;
		const d = this.store.devices[this.deviceKey];
		if (d) {
			this.markers = d.markers || {};
			if (d.lowNote != null) this.opts.lowNote = d.lowNote;
			if (d.highNote != null) this.opts.highNote = d.highNote;
		} else {
			this.markers = {};
		}
		this.setRange(this.opts.lowNote, this.opts.highNote);
	}

	/** Recompute which notes get a marker and (re)build the DOM handles. */
	setRange(lowNote, highNote, save = true) {
		this.opts.lowNote = lowNote;
		this.opts.highNote = highNote;

		// one marker per C in range; fall back to the two extremes if <2 Cs exist
		const cs = [];
		const start = Math.ceil(lowNote / 12) * 12;
		for (let n = start; n <= highNote; n += 12) cs.push(n);
		this.anchorNotes = cs.length >= 2 ? cs : [lowNote, highNote];

		this._ensureMarkers();
		this._rebuildHandles();
		this.render();
		if (save) this._save();
	}

	_ensureMarkers() {
		const notes = this.anchorNotes;
		const wFirst = whitePos(notes[0]);
		const wLast = whitePos(notes[notes.length - 1]);
		const wspan = wLast - wFirst || 1;
		for (const n of notes) {
			if (!this.markers[n]) {
				const frac = (whitePos(n) - wFirst) / wspan;
				this.markers[n] = { x: this.w * (0.1 + 0.8 * frac), y: this.h * 0.72 };
			}
		}
	}

	_rebuildHandles() {
		for (const el of Object.values(this.handleEls)) el.remove();
		this.handleEls = {};
		for (const note of this.anchorNotes) {
			const el = document.createElement('div');
			el.className = 'handle';
			if (note === 60) el.classList.add('mid'); // highlight middle C
			el.innerHTML = `<span>${noteLabel(note)}</span>`;
			this.container.appendChild(el);
			this.handleEls[note] = el;
			this._bindDrag(note, el);
		}
	}

	_bindDrag(note, el) {
		let dx = 0;
		let dy = 0;
		const move = (e) => {
			this.markers[note].x = clamp(e.clientX + dx, 0, this.w);
			this.markers[note].y = clamp(e.clientY + dy, 0, this.h);
			this.render();
			this.onChange();
		};
		const up = (e) => {
			el.releasePointerCapture?.(e.pointerId);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			this._save();
		};
		el.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			const m = this.markers[note];
			dx = m.x - e.clientX;
			dy = m.y - e.clientY;
			el.setPointerCapture?.(e.pointerId);
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
		});
	}

	resize() {
		this.w = window.innerWidth;
		this.h = window.innerHeight;
		for (const m of Object.values(this.markers)) {
			m.x = clamp(m.x, 0, this.w);
			m.y = clamp(m.y, 0, this.h);
		}
		this.render();
	}

	get anchorsSorted() {
		return this.anchorNotes
			.map((n) => ({ note: n, x: this.markers[n].x, y: this.markers[n].y }))
			.sort((a, b) => a.note - b.note);
	}

	/**
	 * client-pixel position for a MIDI note, interpolated within the bracketing
	 * C->C segment (extrapolated past the first/last marker). Black keys are
	 * nudged "back" (perpendicular to the local segment) since they sit further
	 * from the player.
	 */
	noteScreen(note) {
		const A = this.anchorsSorted;
		let i = 0;
		while (i < A.length - 2 && note >= A[i + 1].note) i++;
		const a = A[i];
		const b = A[i + 1];
		const wa = whitePos(a.note);
		const wb = whitePos(b.note);
		const denom = wb - wa || 1;
		const t = (whitePos(note) - wa) / denom;

		let x = a.x + (b.x - a.x) * t;
		let y = a.y + (b.y - a.y) * t;

		if (isBlackKey(note) && this.opts.blackKeyDepth) {
			const sdx = b.x - a.x;
			const sdy = b.y - a.y;
			const len = Math.hypot(sdx, sdy) || 1;
			let px = -sdy / len;
			let py = sdx / len; // perpendicular to the segment
			if (py > 0) {
				px = -px;
				py = -py;
			} // point "up" the screen (toward the back of the keyboard)
			const whiteWidthPx = len / denom;
			const off = this.opts.blackKeyDepth * whiteWidthPx;
			x += px * off;
			y += py * off;
		}
		return { x, y };
	}

	setGuidesVisible(v) {
		this.opts.showGuides = v;
		this.container.classList.toggle('hidden', !v);
		this._save();
	}

	resetHandles() {
		for (const n of this.anchorNotes) delete this.markers[n];
		this._ensureMarkers();
		this.render();
		this.onChange();
		this._save();
	}

	/** redraw the DOM handles + the SVG guide polyline */
	render() {
		const A = this.anchorsSorted;
		for (const { note, x, y } of A) {
			const el = this.handleEls[note];
			if (!el) continue;
			el.style.left = `${x}px`;
			el.style.top = `${y}px`;
		}
		this.poly.setAttribute('points', A.map((p) => `${p.x},${p.y}`).join(' '));
	}

	save() {
		this._save();
	}
}

function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** human label for a MIDI note, e.g. 60 -> "C4" (middle C) */
function noteLabel(note) {
	const pc = ((note % 12) + 12) % 12;
	return NOTE_NAMES[pc] + (Math.floor(note / 12) - 1);
}

// Horizontal position of each pitch class in white-key-width units. White keys
// (C D E F G A B) land on integers; black keys on the half-positions between
// their neighbours. Note there is intentionally no key between E–F or B–C.
//        C   C#  D   D#  E   F   F#  G   G#  A   A#  B
const PC_WHITE = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6];
const BLACK_PC = new Set([1, 3, 6, 8, 10]);

/** continuous white-key-width coordinate for a MIDI note (7 units per octave) */
function whitePos(note) {
	return Math.floor(note / 12) * 7 + PC_WHITE[((note % 12) + 12) % 12];
}

function isBlackKey(note) {
	return BLACK_PC.has(((note % 12) + 12) % 12);
}
