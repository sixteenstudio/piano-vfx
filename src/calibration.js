/**
 * Multi-point keyboard calibration.
 *
 * The user drags one marker onto the centre of every C key they can see
 * (C is the white key immediately left of each pair of black keys). Notes
 * between two C markers are interpolated *per octave segment* using real piano
 * geometry, so the mapping follows the keyboard even when perspective /
 * foreshortening compresses the far end — a single straight line can't do that.
 *
 * Because every C is placed by hand, mirror / back-to-front / angle are all
 * handled implicitly by where the markers land. The only remaining choice is
 * which side the flames shoot (perpendicular to the keyboard) — `flameSide`.
 *
 * Coordinate spaces:
 *   - markers are stored in CSS/client pixels (y-down, origin top-left),
 *   - world space is pixels with origin at screen centre and y-up, matching the
 *     orthographic camera in main.js.
 */
const STORE_KEY = 'piano-vfx-calibration-v2';

export class Calibration {
	constructor(onChange) {
		this.onChange = onChange || (() => {});
		this.w = window.innerWidth;
		this.h = window.innerHeight;

		this.opts = {
			lowNote: 21, // A0  (88-key piano = 21..108)
			highNote: 108, // C8
			flameSide: false,
			showGuides: true,
			blackKeyDepth: 0.35, // how far black keys sit "back" (in white-key widths)
		};

		// marker positions in client px, keyed by MIDI note. Persisted per note so
		// they survive reloads and keyboard-range changes.
		this.markers = {};

		this._load();

		this.container = document.getElementById('calibration');
		this.svg = document.getElementById('cal-svg');
		this.poly = document.getElementById('cal-poly');
		this.flameSeg = document.getElementById('cal-flame-dir');
		this.handleEls = {}; // note -> element

		this.setRange(this.opts.lowNote, this.opts.highNote, false);
	}

	_load() {
		try {
			const s = JSON.parse(localStorage.getItem(STORE_KEY));
			if (s) {
				Object.assign(this.opts, s.opts || {});
				if (s.markers) this.markers = s.markers;
			}
		} catch {
			/* ignore corrupt storage */
		}
	}

	_save() {
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify({ markers: this.markers, opts: this.opts }));
		} catch {
			/* ignore */
		}
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

	/** assign sensible default positions for any anchor note missing one */
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

	/** client px -> world (centre origin, y-up) */
	toWorld(pt) {
		return { x: pt.x - this.w / 2, y: this.h / 2 - pt.y };
	}

	get anchorsSorted() {
		return this.anchorNotes
			.map((n) => ({ note: n, x: this.markers[n].x, y: this.markers[n].y }))
			.sort((a, b) => a.note - b.note);
	}

	/** overall unit vector along the keyboard (first -> last marker), world space */
	get lineDir() {
		const A = this.anchorsSorted;
		const a = this.toWorld(A[0]);
		const b = this.toWorld(A[A.length - 1]);
		const x = b.x - a.x;
		const y = b.y - a.y;
		const len = Math.hypot(x, y) || 1;
		return { x: x / len, y: y / len };
	}

	/** unit vector perpendicular to the keyboard — where flames shoot, world space */
	get flameDir() {
		const d = this.lineDir;
		let n = { x: -d.y, y: d.x };
		if (n.y < 0) n = { x: -n.x, y: -n.y }; // default: point up the screen
		if (this.opts.flameSide) n = { x: -n.x, y: -n.y };
		return n;
	}

	/**
	 * world position for a MIDI note, interpolated within the bracketing C->C
	 * segment (extrapolated beyond the first/last marker). Black keys are nudged
	 * "back" along the flame direction since they sit further from the player.
	 */
	notePosition(note) {
		const A = this.anchorsSorted;
		// pick the segment [A[i], A[i+1]] that brackets the note (clamp to ends)
		let i = 0;
		while (i < A.length - 2 && note >= A[i + 1].note) i++;
		const a = A[i];
		const b = A[i + 1];
		const wa = whitePos(a.note);
		const wb = whitePos(b.note);
		const t = (whitePos(note) - wa) / (wb - wa || 1); // may be <0 or >1 → extrapolate

		const pa = this.toWorld(a);
		const pb = this.toWorld(b);
		let x = pa.x + (pb.x - pa.x) * t;
		let y = pa.y + (pb.y - pa.y) * t;

		if (isBlackKey(note) && this.opts.blackKeyDepth) {
			const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
			const whiteWidthPx = len / (wb - wa || 1);
			const f = this.flameDir;
			const d = this.opts.blackKeyDepth * whiteWidthPx;
			x += f.x * d;
			y += f.y * d;
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

	/** redraw the DOM handles + the SVG guide polyline & flame-direction tick */
	render() {
		const A = this.anchorsSorted;
		for (const { note, x, y } of A) {
			const el = this.handleEls[note];
			if (!el) continue;
			el.style.left = `${x}px`;
			el.style.top = `${y}px`;
		}
		this.poly.setAttribute('points', A.map((p) => `${p.x},${p.y}`).join(' '));

		// flame-direction tick from the middle of the keyboard line
		const mid = A[Math.floor(A.length / 2)];
		const f = this.flameDir; // world, y-up
		const L = 46;
		this.flameSeg.setAttribute('x1', mid.x);
		this.flameSeg.setAttribute('y1', mid.y);
		this.flameSeg.setAttribute('x2', mid.x + f.x * L);
		this.flameSeg.setAttribute('y2', mid.y - f.y * L); // y-up world -> y-down screen
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
