/**
 * Web MIDI wrapper.
 *
 * Emits normalised note events to the host:
 *   onNoteOn(note, velocity 0..1)
 *   onNoteOff(note)
 *
 * Sustain pedal (CC64) is honoured the way a real piano feels: note-offs that
 * arrive while the pedal is down are deferred until the pedal lifts, so held
 * effects keep going. Toggle that off with `sustainHolds = false`.
 */
export class MidiInput {
	constructor({ onNoteOn, onNoteOff, onDevices, onStatus, onSelect }) {
		this.onNoteOn = onNoteOn;
		this.onNoteOff = onNoteOff;
		this.onDevices = onDevices || (() => {});
		this.onStatus = onStatus || (() => {});
		this.onSelect = onSelect || (() => {}); // (deviceName) => void

		this.access = null;
		this.current = null; // bound MIDIInput
		this.sustain = false;
		this.sustainHolds = true; // when false, sustain pedal never holds notes
		this.sustained = new Set(); // notes whose release is pending the pedal
	}

	async init() {
		if (!navigator.requestMIDIAccess) {
			this.onStatus('Web MIDI not supported in this browser — use the computer keys, or Chrome/Edge for MIDI.');
			return false;
		}
		try {
			this.access = await navigator.requestMIDIAccess({ sysex: false });
		} catch (err) {
			this.onStatus('MIDI permission denied. You can still play with the computer keys.');
			return false;
		}
		this.access.onstatechange = () => this.refresh();
		this.refresh();
		return true;
	}

	/** Returns [{ id, name }] for every connected input. */
	listInputs() {
		if (!this.access) return [];
		return [...this.access.inputs.values()].map((i) => ({
			id: i.id,
			name: i.name || i.manufacturer || i.id,
		}));
	}

	refresh() {
		const inputs = this.listInputs();
		this.onDevices(inputs);

		// auto-select the first device, or keep the current one if still present
		if (this.current && inputs.some((d) => d.id === this.current.id)) return;
		if (inputs.length > 0) this.select(inputs[0].id);
		else {
			this.current = null;
			this.onSelect('__default__');
			this.onStatus('No MIDI device detected — plug one in, or use the computer keys.');
		}
	}

	select(id) {
		if (this.current) this.current.onmidimessage = null;
		const input = this.access?.inputs.get(id) || null;
		this.current = input;
		if (input) {
			input.onmidimessage = (e) => this._handle(e.data);
			this.onStatus(`MIDI: ${input.name || input.id} connected.`);
			this.onSelect(input.name || input.id); // device name → load its calibration
		}
	}

	_handle(data) {
		const status = data[0] & 0xf0;
		const d1 = data[1];
		const d2 = data[2];

		if (status === 0x90 && d2 > 0) {
			// note on
			this.sustained.delete(d1);
			this.onNoteOn(d1, d2 / 127);
		} else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
			// note off
			if (this.sustain && this.sustainHolds) this.sustained.add(d1);
			else this.onNoteOff(d1);
		} else if (status === 0xb0 && d1 === 64) {
			// sustain pedal
			const down = d2 >= 64;
			this.sustain = down;
			if (!down) {
				for (const note of this.sustained) this.onNoteOff(note);
				this.sustained.clear();
			}
		}
	}
}

/**
 * Computer-keyboard fallback so the rig is playable before a piano is plugged
 * in. Two rows form ~1.5 octaves of a piano, mapped around middle C (60).
 */
export class KeyboardInput {
	constructor({ onNoteOn, onNoteOff }) {
		this.onNoteOn = onNoteOn;
		this.onNoteOff = onNoteOff;
		this.down = new Set();
		this.octave = 60; // middle C

		// physical key layout -> semitone offset (white = lower row, black = upper)
		this.map = {
			KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6,
			KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13,
			KeyL: 14, KeyP: 15, Semicolon: 16,
		};

		this._kd = (e) => this._onKey(e, true);
		this._ku = (e) => this._onKey(e, false);
		window.addEventListener('keydown', this._kd);
		window.addEventListener('keyup', this._ku);
	}

	_onKey(e, isDown) {
		if (e.repeat) return;
		// don't hijack typing into the GUI's number/text fields
		const t = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

		const off = this.map[e.code];
		if (off === undefined) {
			// octave shift with Z / X
			if (isDown && e.code === 'KeyZ') this.octave = Math.max(24, this.octave - 12);
			if (isDown && e.code === 'KeyX') this.octave = Math.min(96, this.octave + 12);
			return;
		}
		e.preventDefault();
		const note = this.octave + off;
		if (isDown) {
			if (this.down.has(note)) return;
			this.down.add(note);
			this.onNoteOn(note, 0.85);
		} else {
			this.down.delete(note);
			this.onNoteOff(note);
		}
	}
}
