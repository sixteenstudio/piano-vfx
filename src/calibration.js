/**
 * Two-point keyboard calibration.
 *
 * The user drags a LOW handle and a HIGH handle onto the ends of the physical
 * keyboard as seen by the camera. From that single line we derive:
 *   - notePosition(note): where along the line a MIDI note lives,
 *   - lineDir: the unit vector along the keyboard (used for flame wobble),
 *   - flameDir: the unit vector PERPENDICULAR to the keyboard (where flames shoot).
 *
 * Because flames emit perpendicular to the line, the rig works at any camera
 * angle. Two toggles cover the rest of the awkward setups:
 *   - reverseKeys: swap which end is the lowest note (back-to-front pianos),
 *   - flameSide:   shoot flames out the other side of the line.
 *
 * Coordinate spaces:
 *   - handles are stored in CSS/client pixels (y-down, origin top-left),
 *   - world space is pixels with origin at screen centre and y-up, matching the
 *     orthographic camera in main.js.
 */
const STORE_KEY = 'piano-vfx-calibration-v1';

export class Calibration {
	constructor(onChange) {
		this.onChange = onChange || (() => {});
		this.w = window.innerWidth;
		this.h = window.innerHeight;

		this.opts = {
			lowNote: 21, // A0  (88-key piano = 21..108)
			highNote: 108, // C8
			reverseKeys: false,
			flameSide: false,
			showGuides: true,
		};

		// default handle positions (client px): a horizontal line in the lower third,
		// kept clear of the lil-gui panel on the right so both are grabbable on load
		this.p = [
			{ x: this.w * 0.15, y: this.h * 0.72 },
			{ x: this.w * 0.72, y: this.h * 0.72 },
		];

		this._load();

		this.container = document.getElementById('calibration');
		this.handles = [
			document.getElementById('handle-0'),
			document.getElementById('handle-1'),
		];
		this.lineSeg = document.getElementById('cal-line-seg');
		this.flameSeg = document.getElementById('cal-flame-dir');

		this._bindDrag(0);
		this._bindDrag(1);
		this.render();
	}

	_load() {
		try {
			const s = JSON.parse(localStorage.getItem(STORE_KEY));
			if (s) {
				if (Array.isArray(s.p) && s.p.length === 2) this.p = s.p;
				Object.assign(this.opts, s.opts || {});
			}
		} catch {
			/* ignore corrupt storage */
		}
	}

	_save() {
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify({ p: this.p, opts: this.opts }));
		} catch {
			/* ignore */
		}
	}

	_bindDrag(i) {
		const el = this.handles[i];
		let dx = 0;
		let dy = 0;
		const move = (e) => {
			this.p[i].x = clamp(e.clientX + dx, 0, this.w);
			this.p[i].y = clamp(e.clientY + dy, 0, this.h);
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
			dx = this.p[i].x - e.clientX;
			dy = this.p[i].y - e.clientY;
			el.setPointerCapture?.(e.pointerId);
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
		});
	}

	resize() {
		this.w = window.innerWidth;
		this.h = window.innerHeight;
		this.p[0].x = clamp(this.p[0].x, 0, this.w);
		this.p[0].y = clamp(this.p[0].y, 0, this.h);
		this.p[1].x = clamp(this.p[1].x, 0, this.w);
		this.p[1].y = clamp(this.p[1].y, 0, this.h);
		this.render();
	}

	/** client px -> world (centre origin, y-up) */
	toWorld(pt) {
		return { x: pt.x - this.w / 2, y: this.h / 2 - pt.y };
	}

	get p0World() {
		return this.toWorld(this.p[0]);
	}
	get p1World() {
		return this.toWorld(this.p[1]);
	}

	/** unit vector along the keyboard (LOW -> HIGH handle), world space */
	get lineDir() {
		const a = this.p0World;
		const b = this.p1World;
		let x = b.x - a.x;
		let y = b.y - a.y;
		const len = Math.hypot(x, y) || 1;
		return { x: x / len, y: y / len };
	}

	/** unit vector perpendicular to the keyboard — where flames shoot, world space */
	get flameDir() {
		const d = this.lineDir;
		let n = { x: -d.y, y: d.x };
		if (this.flameSideSign() < 0) {
			n = { x: -n.x, y: -n.y };
		}
		return n;
	}

	flameSideSign() {
		// default to the perpendicular that points "up" the screen, then let the
		// flameSide toggle flip it.
		const d = this.lineDir;
		const upward = -d.y >= 0 ? 1 : -1; // n.y = d.x ... pick by world-y of n
		// n = (-d.y, d.x); n.y = d.x. Prefer n.y > 0 (upward in world space).
		const preferUp = d.x >= 0 ? 1 : -1;
		return (this.opts.flameSide ? -1 : 1) * preferUp;
	}

	/** world position for a MIDI note */
	notePosition(note) {
		const { lowNote, highNote } = this.opts;
		const span = highNote - lowNote || 1;
		let t = clamp((note - lowNote) / span, 0, 1);
		if (this.opts.reverseKeys) t = 1 - t;
		const a = this.p0World;
		const b = this.p1World;
		return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
	}

	setGuidesVisible(v) {
		this.opts.showGuides = v;
		this.container.classList.toggle('hidden', !v);
		this._save();
	}

	resetHandles() {
		this.p = [
			{ x: this.w * 0.15, y: this.h * 0.72 },
			{ x: this.w * 0.72, y: this.h * 0.72 },
		];
		this.render();
		this.onChange();
		this._save();
	}

	/** redraw the DOM handles + SVG guide lines */
	render() {
		for (let i = 0; i < 2; i++) {
			this.handles[i].style.left = `${this.p[i].x}px`;
			this.handles[i].style.top = `${this.p[i].y}px`;
		}
		this.lineSeg.setAttribute('x1', this.p[0].x);
		this.lineSeg.setAttribute('y1', this.p[0].y);
		this.lineSeg.setAttribute('x2', this.p[1].x);
		this.lineSeg.setAttribute('y2', this.p[1].y);

		// flame-direction tick from the line midpoint (convert world dir -> screen)
		const mx = (this.p[0].x + this.p[1].x) / 2;
		const my = (this.p[0].y + this.p[1].y) / 2;
		const f = this.flameDir; // world, y-up
		const L = 46;
		this.flameSeg.setAttribute('x1', mx);
		this.flameSeg.setAttribute('y1', my);
		this.flameSeg.setAttribute('x2', mx + f.x * L);
		this.flameSeg.setAttribute('y2', my - f.y * L); // y-up world -> y-down screen
	}

	save() {
		this._save();
	}
}

function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}
