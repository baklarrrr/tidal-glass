import { a as e, d as t, f as n, n as r, o as i, r as a, t as o } from "./state-BujoNwcN.js";
import { i as s } from "./pushkin-C5TU0Pwc.js";
import { a as c, t as l } from "./audio-context-store-Bf50rcqa.js";
import { _ as u, c as d, n as f, t as p, v as m, y as h } from "./load-uTL4eiru.js";
import { n as g } from "./active-device-mode-changed-OmLVES_4.js";
import { n as _ } from "./active-device-changed-BDbOSq7P.js";
//#region src/internal/handlers/get-asset-position.ts
function v() {
	return o.activePlayer?.getPosition() ?? 0;
}
//#endregion
//#region src/internal/handlers/get-audio-adaptive-bitrate-streaming.ts
function y() {
	return t("audioAdaptiveBitrateStreaming");
}
//#endregion
//#region src/internal/handlers/get-loudness-normalization-mode.ts
function b() {
	return t("loudnessNormalizationMode");
}
//#endregion
//#region src/internal/handlers/get-media-product.ts
function x() {
	return o.activePlayer?.currentMediaProduct ?? null;
}
//#endregion
//#region src/internal/handlers/get-next-media-product.ts
function S() {
	return o.preloadedMediaProduct ?? null;
}
//#endregion
//#region src/internal/handlers/get-output-devices.ts
async function C() {
	let { outputDevices: e } = await import("./output-devices-DLDX8cVL.js");
	return [...e.outputDevices];
}
//#endregion
//#region src/internal/handlers/get-playback-context.ts
function w() {
	let e = o.activePlayer;
	if (e) {
		let t = r.getMediaProductTransition(e.currentStreamingSessionId);
		if (t) return t.playbackContext;
	}
}
//#endregion
//#region src/internal/handlers/get-playback-state.ts
function T() {
	return o.activePlayer?.playbackState ?? "IDLE";
}
//#endregion
//#region src/internal/handlers/get-player-version.ts
function E() {
	return "0.20.1";
}
//#endregion
//#region src/internal/handlers/get-streaming-wifi-audio-quality.ts
function D() {
	return t("streamingWifiAudioQuality");
}
//#endregion
//#region src/internal/handlers/get-transition-mode.ts
function O() {
	return t("crossfadeInMs");
}
//#endregion
//#region src/internal/handlers/get-volume-level.ts
function k() {
	return t("desiredVolumeLevel");
}
//#endregion
//#region src/internal/handlers/pause.ts
function A() {
	return o.activePlayer?.pause();
}
//#endregion
//#region src/internal/handlers/play.ts
async function j() {
	await s.synchronize();
	let { activePlayer: e } = o;
	return e ? (a.dispatchEvent(new CustomEvent("user-action")), e.play()) : Promise.reject(/* @__PURE__ */ Error("No active player"));
}
//#endregion
//#region src/internal/handlers/seek.ts
async function M(e) {
	let { activePlayer: t } = o;
	return t?.seek(e);
}
//#endregion
//#region src/internal/handlers/set-api-url.ts
function N(e) {
	try {
		new URL(e);
	} catch (e) {
		throw e;
	}
	n({ apiUrl: e });
}
//#endregion
//#region src/internal/handlers/set-audio-adaptive-bitrate-streaming.ts
function P(e) {
	n({ audioAdaptiveBitrateStreaming: e });
}
//#endregion
//#region src/internal/handlers/set-credentials-provider.ts
function F(t) {
	e.credentialsProvider = t;
}
//#endregion
//#region src/internal/handlers/set-event-sender.ts
function I(e) {
	i.eventSender = e;
}
//#endregion
//#region src/internal/handlers/set-legacy-api-url.ts
function L(e) {
	try {
		new URL(e);
	} catch (e) {
		throw e;
	}
	n({ legacyApiUrl: e });
}
//#endregion
//#region src/internal/handlers/set-loudness-normalization-mode.ts
function R(e) {
	n({ loudnessNormalizationMode: e }), o.activePlayer?.updateVolumeLevel();
}
//#endregion
//#region src/internal/helpers/on.ts
function z(e, t) {
	return new Promise((n) => {
		e.addEventListener(t, (e) => n(e), { once: !0 });
	});
}
//#endregion
//#region src/internal/handlers/set-output-device-mode.ts
async function B(e = "shared") {
	let { outputDevices: t } = await import("./output-devices-DLDX8cVL.js"), n = z(a, g);
	t.deviceMode = e;
	let r = await n;
	if (r instanceof CustomEvent && r.detail === e) return e;
	throw Error("Could not set new device mode.");
}
//#endregion
//#region src/internal/handlers/set-output-device.ts
async function V(e) {
	let { outputDevices: t } = await import("./output-devices-DLDX8cVL.js"), n = z(a, _), r = [...t.outputDevices].find((t) => t.id === e);
	if (!r) throw ReferenceError("Output device does not exist: " + e);
	t.activeDevice = r;
	let i = await n;
	if (i instanceof CustomEvent && i.detail === e) return e;
	throw Error("Could not set new device.");
}
//#endregion
//#region src/internal/handlers/set-streaming-wifi-audio-quality.ts
function H(e) {
	n({ streamingWifiAudioQuality: e });
}
//#endregion
//#region src/internal/handlers/set-transition-mode.ts
var U = 0, W = 15e3;
function G(e) {
	n({ crossfadeInMs: Math.max(U, Math.min(W, Math.round(Number.isFinite(e) ? e : 0))) });
}
//#endregion
//#region src/internal/handlers/set-volume-level.ts
function K(e) {
	n({ desiredVolumeLevel: e });
}
//#endregion
//#region src/internal/handlers/start-native-player.ts
async function q() {
	let e = await u();
	m(e);
}
//#endregion
//#region src/index.ts
s.synchronize().then().catch(console.error);
function J() {
	let { activePlayer: e } = o;
	if (!e) return null;
	switch (e.name) {
		case "browserPlayer": return e.mediaElement;
		case "shakaPlayer": return e.mediaElement;
		default: return null;
	}
}
function Y(e) {
	o.activePlayer = void 0, e.outputDevices === !0 && n({ outputDevicesEnabled: !0 }), h(e.players);
}
function X() {
	let e = localStorage.getItem("ssuid");
	try {
		e && indexedDB.deleteDatabase("streaming-sessions-" + e);
	} catch (t) {
		console.warn(`DB streaming-sessions-${e} could not be deleted`), console.error(t);
	}
}
c().then().catch(console.error), l().then().catch(console.error), X();
//#endregion
export { Y as bootstrap, a as events, v as getAssetPosition, y as getAudioAdaptiveBitrateStreaming, b as getLoudnessNormalizationMode, J as getMediaElement, x as getMediaProduct, S as getNextMediaProduct, C as getOutputDevices, w as getPlaybackContext, T as getPlaybackState, E as getPlayerVersion, D as getStreamingWifiAudioQuality, O as getTransitionMode, k as getVolumeLevel, p as load, A as pause, j as play, d as reset, M as seek, N as setApiUrl, P as setAudioAdaptiveBitrateStreaming, F as setCredentialsProvider, I as setEventSender, L as setLegacyApiUrl, R as setLoudnessNormalizationMode, f as setNext, V as setOutputDevice, B as setOutputDeviceMode, H as setStreamingWifiAudioQuality, G as setTransitionMode, K as setVolumeLevel, q as startNativePlayer };

