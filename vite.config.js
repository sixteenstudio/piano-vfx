import { defineConfig } from 'vite';

// Web MIDI, getUserMedia and WebGPU all require a "secure context" — http://localhost
// already qualifies, so no HTTPS setup is needed for local dev.
export default defineConfig({
	server: {
		open: true,
		host: true, // also expose on the LAN if you want to test from another device
	},
});
