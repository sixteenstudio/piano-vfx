import * as THREE from 'three/webgpu';
import {
	uniform,
	texture,
	screenUV,
	normalView,
	positionViewDirection,
	positionLocal,
	modelWorldMatrix,
	vec3,
	float,
	mix,
	pow,
	oneMinus,
	clamp,
	dot,
	normalize,
	sin,
	time,
	length,
} from 'three/tsl';

const LOCAL_Z = new THREE.Vector3(0, 0, 1);
const DEG2RAD = Math.PI / 180;

// scratch
const _near = new THREE.Vector3();
const _far = new THREE.Vector3();
const _nudge = new THREE.Vector3();
const _qRoll = new THREE.Quaternion();
const _projView = new THREE.Matrix4();

/**
 * Glassy, refracting "note bars".
 *
 * key-down  → a cuboid starts with its near face glued to the key (a point on
 *             the z=0 plane). While held, the far end EXTENDS along a user-set
 *             3D direction (length can be unbounded — bar length reads as note
 *             duration).
 * key-up    → growth stops; the whole bar then TRANSLATES along that direction
 *             at its frozen length until it leaves the camera frustum, then it's
 *             culled. (It does not shrink/dissolve.)
 *
 * Look: a fake-glass TSL material on opaque geometry — screen-space refraction
 * of the webcam background, a fresnel rim, a pulsating subsurface glow core, and
 * a slow silky "electrified" outline. One shared material; per-bar variety comes
 * from each bar's (smoothly varying) world position, so no per-mesh uniforms.
 *
 * Flicker note: the geometry origin is the NEAR face (z in [0,1]), so a growing
 * bar's transform origin doesn't move (only its z-scale changes), and the pulse
 * phase is a SMOOTH function of position (not a hash) so a translating bar also
 * stays stable.
 */
export class BarSystem {
	constructor({ videoTexture, coverScale }) {
		this.max = 48;
		this.group = new THREE.Group();
		this.dir = new THREE.Vector3(0, 0.5, 0.9).normalize();
		this.uCoverScale = coverScale;
		this.frustum = new THREE.Frustum();

		this.params = {
			color: '#36d1ff', // subsurface glow colour
			tint: '#dbeeff', // glass tint applied to the refracted webcam
			glow: 0.75,
			glowFloor: 0.18,
			pulseSpeed: 3.0,
			pulseWave: 1.4,
			refraction: 0.07,
			fresnel: 1.1,
			fresnelPow: 3.0,

			// shape (cross-section) + growth
			width: 0.18, // local X
			depth: 0.18, // local Y ("how deep")
			extendSpeed: 2.6, // scene units / second (growth, and travel after release)
			infiniteLength: true,
			maxLength: 6.0, // used only when infiniteLength is off

			// slow "electrified" silky outline
			arc: 0.9,
			arcColor: '#bff4ff',
			arcSpeed: 0.55,
			arcFreq: 5.0,
			edgeSharp: 2.4,

			// transforms
			nudgeX: 0,
			nudgeY: 0,
			nudgeZ: 0,
			dirX: 0,
			dirY: 0.5,
			dirZ: 0.9,
			roll: 0, // degrees, rotation about the bar's own length axis
		};

		this._buildMaterial(videoTexture);
		this._buildPool();
		this.activeByNote = new Map();
	}

	_buildMaterial(videoTex) {
		const p = this.params;
		this.uColor = uniform(new THREE.Color(p.color));
		this.uTint = uniform(new THREE.Color(p.tint));
		this.uGlow = uniform(p.glow);
		this.uGlowFloor = uniform(p.glowFloor);
		this.uPulseSpeed = uniform(p.pulseSpeed);
		this.uPulseWave = uniform(p.pulseWave);
		this.uRefract = uniform(p.refraction);
		this.uFresnel = uniform(p.fresnel);
		this.uFresnelPow = uniform(p.fresnelPow);
		this.uArc = uniform(p.arc);
		this.uArcColor = uniform(new THREE.Color(p.arcColor));
		this.uArcSpeed = uniform(p.arcSpeed);
		this.uArcFreq = uniform(p.arcFreq);
		this.uEdgeSharp = uniform(p.edgeSharp);

		const nV = normalize(normalView);
		const viewDir = normalize(positionViewDirection);
		const rim = oneMinus(clamp(dot(nV, viewDir), 0, 1)); // 0 facing camera → 1 at grazing

		// refract the webcam background in screen space
		const bgUV = screenUV.sub(0.5).mul(this.uCoverScale).add(0.5);
		const bg = texture(videoTex, bgUV.add(nV.xy.mul(this.uRefract))).rgb;
		const tinted = bg.mul(this.uTint);

		const fres = pow(rim, this.uFresnelPow).mul(this.uFresnel);

		// smooth per-bar phase from world position (NOT a hash → no flicker when
		// the bar grows or flies off)
		const trans = modelWorldMatrix.element(3); // translation column
		const phase = dot(trans.xyz, vec3(1.3, 2.1, 0.7)); // smooth scalar (no hash)
		const along = positionLocal.z; // 0 near face → 1 far face

		// pulsating subsurface glow core
		const wave = sin(time.mul(this.uPulseSpeed).sub(along.mul(this.uPulseWave.mul(6.2831853))).add(phase))
			.mul(0.5)
			.add(0.5);
		const core = oneMinus(clamp(length(positionLocal.xy).mul(2.0), 0, 1));
		const glowAmt = mix(this.uGlowFloor, float(1.0), wave).mul(this.uGlow).mul(mix(float(0.5), float(1.35), core));
		const glow = this.uColor.mul(glowAmt);

		// slow silky electrified outline: the (sharp) fresnel rim, modulated by a
		// gentle two-sine flow travelling along the bar
		const f1 = sin(along.mul(this.uArcFreq).sub(time.mul(this.uArcSpeed)).add(phase)).mul(0.5).add(0.5);
		const f2 = sin(along.mul(this.uArcFreq.mul(0.37)).add(time.mul(this.uArcSpeed.mul(0.55))).add(phase.mul(2.1)).add(1.3))
			.mul(0.5)
			.add(0.5);
		const flow = mix(float(0.2), float(1.0), f1.mul(f2));
		const arc = pow(rim, this.uEdgeSharp).mul(flow).mul(this.uArc);
		const electric = this.uArcColor.mul(arc);

		const mat = new THREE.MeshBasicNodeMaterial();
		mat.colorNode = tinted.add(glow).add(this.uColor.mul(fres)).add(electric);
		this.material = mat;

		// origin at the NEAR face: z in [0,1]
		this.geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
	}

	_buildPool() {
		this.slots = [];
		for (let i = 0; i < this.max; i++) {
			const mesh = new THREE.Mesh(this.geometry, this.material);
			mesh.visible = false;
			mesh.frustumCulled = false;
			this.group.add(mesh);
			this.slots.push({
				mesh,
				active: false,
				note: -1,
				base: new THREE.Vector3(), // raw key point on z=0
				length: 0,
				travel: 0, // distance flown after release
				vel: 1,
				growing: false,
				released: false,
				age: 0,
			});
		}
	}

	_freeSlot() {
		for (const s of this.slots) if (!s.active) return s;
		let best = this.slots[0];
		for (const s of this.slots) if (s.age > best.age) best = s;
		return best;
	}

	spawn(note, base, vel = 0.8) {
		if (this.activeByNote.has(note)) this.release(note); // retrigger
		const s = this._freeSlot();
		s.active = true;
		s.note = note;
		s.base.copy(base);
		s.length = 0;
		s.travel = 0;
		s.vel = vel;
		s.growing = true;
		s.released = false;
		s.age = 0;
		s.mesh.visible = true;
		this.activeByNote.set(note, s);
	}

	/** key-up: stop growing; the bar now coasts off along the direction */
	release(note) {
		const s = this.activeByNote.get(note);
		if (s) {
			s.growing = false;
			s.released = true;
			this.activeByNote.delete(note);
		}
	}

	clear() {
		for (const s of this.slots) {
			s.active = s.growing = s.released = false;
			s.mesh.visible = false;
		}
		this.activeByNote.clear();
	}

	update(dt, camera) {
		const p = this.params;
		this.dir.set(p.dirX, p.dirY, p.dirZ);
		if (this.dir.lengthSq() < 1e-6) this.dir.set(0, 0, 1);
		this.dir.normalize();
		const dir = this.dir;
		_nudge.set(p.nudgeX, p.nudgeY, p.nudgeZ);

		// frustum for culling released bars once they leave view
		camera.updateMatrixWorld();
		_projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		this.frustum.setFromProjectionMatrix(_projView);

		for (const s of this.slots) {
			if (!s.active) continue;
			s.age += dt;

			if (s.growing) {
				s.length += p.extendSpeed * dt;
				if (!p.infiniteLength) s.length = Math.min(s.length, p.maxLength);
			}
			if (s.released) s.travel += p.extendSpeed * dt;

			const w = Math.max(p.width * (0.4 + 0.6 * s.vel), 1e-4);
			const d = Math.max(p.depth * (0.4 + 0.6 * s.vel), 1e-4);
			const len = Math.max(s.length, 1e-4);

			// near face = key + nudge + (travel along dir once released)
			_near.copy(s.base).add(_nudge).addScaledVector(dir, s.travel);
			s.mesh.position.copy(_near);
			s.mesh.scale.set(w, d, len);
			s.mesh.quaternion.setFromUnitVectors(LOCAL_Z, dir);
			if (p.roll) s.mesh.quaternion.premultiply(_qRoll.setFromAxisAngle(dir, p.roll * DEG2RAD));

			if (s.released && this._outOfView(_near, dir, len, Math.max(w, d))) {
				s.active = false;
				s.mesh.visible = false;
			}
		}
	}

	/** true if the whole near→far segment is outside the frustum (any one plane) */
	_outOfView(near, dir, len, margin) {
		_far.copy(near).addScaledVector(dir, len);
		for (const plane of this.frustum.planes) {
			if (plane.distanceToPoint(near) < -margin && plane.distanceToPoint(_far) < -margin) {
				return true;
			}
		}
		return false;
	}

	syncUniforms() {
		const p = this.params;
		this.uColor.value.set(p.color);
		this.uTint.value.set(p.tint);
		this.uGlow.value = p.glow;
		this.uGlowFloor.value = p.glowFloor;
		this.uPulseSpeed.value = p.pulseSpeed;
		this.uPulseWave.value = p.pulseWave;
		this.uRefract.value = p.refraction;
		this.uFresnel.value = p.fresnel;
		this.uFresnelPow.value = p.fresnelPow;
		this.uArc.value = p.arc;
		this.uArcColor.value.set(p.arcColor);
		this.uArcSpeed.value = p.arcSpeed;
		this.uArcFreq.value = p.arcFreq;
		this.uEdgeSharp.value = p.edgeSharp;
	}
}
