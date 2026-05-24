/**
 * Webcam feed shown as a CSS background <video> behind the (screen-blended)
 * WebGPU canvas. Keeping the video in the DOM — rather than as a GPU texture —
 * means flame light simply "screens" over the live image with zero extra
 * compositing work, and mirror/flip become one-line CSS transforms.
 */
export class Webcam {
	constructor(videoEl) {
		this.video = videoEl;
		this.stream = null;
		this.flipX = true; // most webcams feel natural mirrored
		this.flipY = false;
	}

	async start(deviceId) {
		this.stop();
		// Request the camera's native/maximum resolution so the feed stays sharp
		// instead of being upscaled to fill the screen. The browser clamps these
		// "ideal" values down to whatever the device actually supports.
		const res = {
			width: { ideal: 3840 },
			height: { ideal: 2160 },
			frameRate: { ideal: 60 },
		};
		const constraints = {
			audio: false,
			video: deviceId ? { deviceId: { exact: deviceId }, ...res } : res,
		};
		this.stream = await navigator.mediaDevices.getUserMedia(constraints);
		this.video.srcObject = this.stream;
		await this.video.play().catch(() => {});
		this.applyTransform();
	}

	stop() {
		if (this.stream) {
			for (const t of this.stream.getTracks()) t.stop();
			this.stream = null;
		}
	}

	/** [{ id, label }] of available cameras (labels need an active permission). */
	async listCameras() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			return devices
				.filter((d) => d.kind === 'videoinput')
				.map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
		} catch {
			return [];
		}
	}

	applyTransform() {
		this.video.style.setProperty('--flip-x', this.flipX ? -1 : 1);
		this.video.style.setProperty('--flip-y', this.flipY ? -1 : 1);
	}
}
