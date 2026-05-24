import * as THREE from 'three/webgpu';
import {
	attribute,
	positionGeometry,
	uv,
	vec3,
	float,
	mix,
	smoothstep,
	length,
	pow,
	oneMinus,
	uniform,
} from 'three/tsl';

const MAX_PARTICLES = 6000;

// Fire colour ramp (hot core -> cooling embers), tunable via `warmth`.
const HOT = new THREE.Color(1.0, 0.96, 0.78);
const MID = new THREE.Color(1.0, 0.52, 0.13);
const COOL = new THREE.Color(0.82, 0.11, 0.04);

/**
 * GPU-instanced additive flame particles.
 *
 * Simulation runs on the CPU (a few thousand particles is trivial and keeps the
 * spawn logic dead simple), while rendering is fully WebGPU via a TSL node
 * material: every particle is one instanced quad, billboarded for free because
 * the scene uses a fixed orthographic camera looking straight down -Z.
 *
 * World units == CSS pixels (see the orthographic camera in main.js), so all
 * sizes / speeds below are in pixels and pixels-per-second.
 */
export class FlameSystem {
	constructor() {
		this.max = MAX_PARTICLES;

		// --- per-particle CPU state (structure-of-arrays) ---
		this.px = new Float32Array(this.max);
		this.py = new Float32Array(this.max);
		this.vx = new Float32Array(this.max);
		this.vy = new Float32Array(this.max);
		this.age = new Float32Array(this.max);
		this.life = new Float32Array(this.max);
		this.intensity = new Float32Array(this.max);
		this.phase = new Float32Array(this.max);
		this.alive = new Uint8Array(this.max);

		// free-slot stack
		this.free = new Int32Array(this.max);
		for (let i = 0; i < this.max; i++) this.free[i] = this.max - 1 - i;
		this.freeCount = this.max;

		// --- GPU instance attributes (uploaded each frame) ---
		this.offsetArr = new Float32Array(this.max * 3); // xy position (+unused z)
		this.dataArr = new Float32Array(this.max * 4); // ageFraction, intensity, seed, alive

		// tunables (live-editable from lil-gui)
		this.params = {
			emitRate: 110, // particles / second at full velocity
			speed: 240, // initial launch speed along the flame direction
			spread: 70, // random sideways launch speed
			buoyancy: 160, // ongoing acceleration along the flame direction
			turbulence: 150, // sideways wobble acceleration
			lifetime: 0.95, // seconds
			sizeBase: 46, // base sprite size (px)
			brightness: 1.35,
			warmth: 1.0,
		};

		// shared direction vectors, refreshed from calibration each frame
		this.flameDir = { x: 0, y: 1 }; // unit: where flames shoot
		this.lineDir = { x: 1, y: 0 }; // unit: along the keyboard (wobble axis)

		this._buildObject();
	}

	_buildObject() {
		const geo = new THREE.InstancedBufferGeometry();
		geo.instanceCount = this.max;

		// a unit quad centred on origin
		geo.setAttribute(
			'position',
			new THREE.Float32BufferAttribute(
				[-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
				3,
			),
		);
		geo.setAttribute(
			'uv',
			new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2),
		);
		geo.setIndex([0, 1, 2, 0, 2, 3]);

		this.aOffset = new THREE.InstancedBufferAttribute(this.offsetArr, 3).setUsage(
			THREE.DynamicDrawUsage,
		);
		this.aData = new THREE.InstancedBufferAttribute(this.dataArr, 4).setUsage(
			THREE.DynamicDrawUsage,
		);
		geo.setAttribute('aOffset', this.aOffset);
		geo.setAttribute('aData', this.aData);

		// uniforms shared with the GUI
		this.uSize = uniform(this.params.sizeBase);
		this.uBright = uniform(this.params.brightness);
		this.uWarm = uniform(this.params.warmth);
		this.uHot = uniform(new THREE.Color().copy(HOT));
		this.uMid = uniform(new THREE.Color().copy(MID));
		this.uCool = uniform(new THREE.Color().copy(COOL));

		// ---- TSL node graph ----
		const aOffsetN = attribute('aOffset', 'vec3');
		const aDataN = attribute('aData', 'vec4');
		const ageF = aDataN.x; // 0..1 normalised age
		const inten = aDataN.y; // 0..1 note velocity
		const aliveF = aDataN.w; // 0 or 1

		// size: launch small, swell as it rises, pinch out at the very end
		const grow = mix(float(0.45), float(1.35), ageF);
		const shrink = oneMinus(smoothstep(float(0.72), float(1.0), ageF));
		const size = this.uSize
			.mul(float(0.4).add(inten.mul(0.85)))
			.mul(grow)
			.mul(shrink);

		const corner = positionGeometry.xy.mul(size);

		const material = new THREE.MeshBasicNodeMaterial();
		material.transparent = true;
		material.depthWrite = false;
		material.depthTest = false;
		material.blending = THREE.AdditiveBlending;
		material.positionNode = vec3(aOffsetN.xy.add(corner), 0.0);

		// soft round sprite with a hotter core
		const d = length(uv().sub(0.5));
		const radial = smoothstep(float(0.5), float(0.0), d);
		const core = pow(radial, float(2.2));

		// colour ramp over life
		let col = mix(this.uHot, this.uMid, smoothstep(float(0.0), float(0.32), ageF));
		col = mix(col, this.uCool, smoothstep(float(0.32), float(0.92), ageF));
		col = col.mul(this.uWarm).mul(float(0.55).add(core.mul(0.85)));

		const fadeIn = smoothstep(float(0.0), float(0.05), ageF);
		const fadeOut = oneMinus(smoothstep(float(0.55), float(1.0), ageF));
		const opacity = radial
			.mul(fadeIn)
			.mul(fadeOut)
			.mul(float(0.45).add(inten.mul(0.75)))
			.mul(this.uBright)
			.mul(aliveF);

		material.colorNode = col;
		material.opacityNode = opacity;

		this.material = material;
		this.mesh = new THREE.Mesh(geo, material);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 1;
	}

	/** Push tunables from the GUI into the shader uniforms. */
	syncUniforms() {
		this.uSize.value = this.params.sizeBase;
		this.uBright.value = this.params.brightness;
		this.uWarm.value = this.params.warmth;
	}

	/** Spawn one particle. x,y in world(px); intensity 0..1. */
	spawn(x, y, intensity) {
		if (this.freeCount === 0) return;
		const i = this.free[--this.freeCount];

		const f = this.flameDir;
		const l = this.lineDir;
		const p = this.params;

		// launch mostly along the flame direction, with random sideways spread
		const launch = p.speed * (0.6 + 0.7 * intensity) * (0.85 + Math.random() * 0.3);
		const side = (Math.random() * 2 - 1) * p.spread;
		// small jitter along the key line so a single key reads as a band of flame
		const jitter = (Math.random() * 2 - 1) * 7;

		this.px[i] = x + l.x * jitter;
		this.py[i] = y + l.y * jitter;
		this.vx[i] = f.x * launch + l.x * side;
		this.vy[i] = f.y * launch + l.y * side;
		this.age[i] = 0;
		this.life[i] = p.lifetime * (0.75 + Math.random() * 0.5);
		this.intensity[i] = intensity;
		this.phase[i] = Math.random() * Math.PI * 2;
		this.alive[i] = 1;
	}

	/** Integrate all live particles and upload to the GPU. */
	update(dt, time) {
		const f = this.flameDir;
		const l = this.lineDir;
		const p = this.params;
		const off = this.offsetArr;
		const data = this.dataArr;

		for (let i = 0; i < this.max; i++) {
			if (!this.alive[i]) {
				data[i * 4 + 3] = 0; // mark dead -> invisible
				continue;
			}

			let a = this.age[i] + dt;
			if (a >= this.life[i]) {
				this.alive[i] = 0;
				data[i * 4 + 3] = 0;
				this.free[this.freeCount++] = i;
				continue;
			}
			this.age[i] = a;

			// buoyancy along flame dir + sideways turbulence along the key line
			const wob = Math.sin(time * 7.0 + this.phase[i]) * p.turbulence;
			this.vx[i] += (f.x * p.buoyancy + l.x * wob) * dt;
			this.vy[i] += (f.y * p.buoyancy + l.y * wob) * dt;
			// mild drag
			const drag = 1 - 0.6 * dt;
			this.vx[i] *= drag;
			this.vy[i] *= drag;

			this.px[i] += this.vx[i] * dt;
			this.py[i] += this.vy[i] * dt;

			const b = i * 3;
			off[b] = this.px[i];
			off[b + 1] = this.py[i];
			off[b + 2] = 0;

			const c = i * 4;
			data[c] = a / this.life[i]; // age fraction
			data[c + 1] = this.intensity[i];
			data[c + 2] = this.phase[i]; // seed (unused in shader, reserved)
			data[c + 3] = 1;
		}

		this.aOffset.needsUpdate = true;
		this.aData.needsUpdate = true;
	}

	/** Instantly extinguish everything (panic button). */
	clear() {
		this.alive.fill(0);
		this.dataArr.fill(0);
		this.freeCount = this.max;
		for (let i = 0; i < this.max; i++) this.free[i] = this.max - 1 - i;
		this.aData.needsUpdate = true;
	}

	get liveCount() {
		return this.max - this.freeCount;
	}
}
