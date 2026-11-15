import { i as e } from "./generate-guid-C7EoYu64.js";
import { a as t, d as n, i as r, l as i, n as a, r as o, t as s } from "./state-BujoNwcN.js";
import { i as c } from "./pushkin-C5TU0Pwc.js";
import { i as l, n as u, r as d } from "./audio-context-store-Bf50rcqa.js";
import { d as f, f as p, g as m, l as h, m as g, u as _ } from "./load-uTL4eiru.js";
import { t as v } from "./active-device-changed-BDbOSq7P.js";
import { n as y, r as b, t as x } from "./basePlayer-taUs4qIw.js";
import { t as S } from "./media-element-error-circuit-breaker-BgFhgr5-.js";
//#region src/api/event/playback-quality-changed.ts
var C = /* @__PURE__ */ e(_(), 1);
function w(e) {
	return new CustomEvent("playback-quality-changed", { detail: { playbackContext: e } });
}
//#endregion
//#region src/internal/helpers/update-playback-quality.ts
function T(e) {
	let t = e.audioCodec;
	if (t === "flac") {
		let t = e.originalAudioId == null ? void 0 : E(e.originalAudioId);
		return e.audioSamplingRate && e.audioSamplingRate > 44100 || t != null && t > 16 ? "HI_RES_LOSSLESS" : "LOSSLESS";
	}
	return t === "mp4a.40.2" ? "HIGH" : "LOW";
}
function E(e) {
	if (!e?.includes(",")) return;
	let t = e.match(/\d+/g)?.at(-1);
	return t == null ? void 0 : Number(t);
}
function D(e, t) {
	if (e && t?.audioCodec) {
		let n = a.getMediaProductTransition(e);
		if (!n) {
			console.warn("No media product transition saved.");
			return;
		}
		let { mediaProduct: r, playbackContext: i } = n, s = {
			...i,
			actualAudioQuality: T(t),
			bandwidth: t.bandwidth ?? null,
			bitDepth: t.originalAudioId ? E(t.originalAudioId) ?? null : null,
			codec: t.audioCodec ? f(t.audioCodec) ?? null : null,
			sampleRate: t.audioSamplingRate ?? null
		};
		a.saveMediaProductTransition(e, {
			mediaProduct: r,
			playbackContext: s
		}), o.dispatchEvent(w(s));
	}
}
//#endregion
//#region src/player/adaptations.ts
function O(e, t) {
	let n = c.now(), r = e.mimeType, i = e.codecs, a = e.bandwidth, o = e.width;
	return {
		assetPosition: t,
		bandwidth: a,
		codecs: i,
		mimeType: r,
		timestamp: n,
		videoHeight: e.height,
		videoWidth: o
	};
}
async function k(e, t, n) {
	let r = O(t, n);
	return r.mimeType && r.codecs && await g({
		adaptations: [r],
		streamingSessionId: e
	}), r;
}
function A(e, t, n) {
	let r = () => {
		if (!n()) return;
		let r = e.getVariantTracks().find((e) => e.active), i = e.getMediaElement(), a = t();
		a && i && k(a, r, i.currentTime).catch(console.error);
	}, i = (e) => {
		if (!n()) return;
		r();
		let i = e.newTrack, a = t();
		a && D(a, i);
	};
	return e.addEventListener("adaptation", i), e.addEventListener("variantchanged", r), function() {
		e.removeEventListener("adaptation", i), e.removeEventListener("variantchanged", r);
	};
}
//#endregion
//#region src/player/fairplay-drm.ts
async function j() {
	try {
		let e = await (await fetch("https://fp.fa.tidal.com/certificate")).arrayBuffer();
		return new Uint8Array(e);
	} catch (e) {
		throw console.error("Failed to retrieve the server certificate.", e);
	}
}
//#endregion
//#region src/player/stalls.ts
var M = {
	isPlaying: !1,
	isSeeking: !1
}, N = (e) => new Promise((t) => e.addEventListener("waiting", () => t(), { once: !0 })), P = (e) => new Promise((t) => e.addEventListener("playing", () => t(), { once: !0 }));
function F() {
	M.isSeeking = !0;
}
function I() {
	M.isSeeking = !1;
}
function L() {
	M.isPlaying = !1;
}
async function R(e, t) {
	M.isPlaying = !0, await N(e);
	let n = e.currentTime;
	if (!M.isPlaying || n === 0) return;
	let r = c.now(), i = M.isSeeking ? "SEEK" : "UNEXPECTED";
	await P(e);
	let a = {
		assetPosition: n,
		endTimestamp: c.now(),
		reason: i,
		startTimestamp: r
	};
	g({
		stalls: [a],
		streamingSessionId: t
	});
}
function z(e) {
	let t;
	o.addEventListener("media-product-transition", (e) => {
		e instanceof CustomEvent && (t = e.detail.playbackContext.playbackSessionId);
	});
	let n = () => L(), r = () => {
		t && R(e, t).catch(console.error);
	}, i = () => F(), a = () => I();
	return e.addEventListener("seeking", i), e.addEventListener("seeked", a), e.addEventListener("playing", r), e.addEventListener("paused", n), function() {
		e.removeEventListener("seeking", i), e.removeEventListener("seeked", a), e.removeEventListener("playing", r), e.removeEventListener("paused", n);
	};
}
//#endregion
//#region src/player/shakaPlayer.ts
var B;
function V(e) {
	switch (e.split("/").pop()?.split("?")[0]) {
		case "fairplay": return "FAIR_PLAY";
		case "widevine": return "WIDEVINE";
		default: return "NONE";
	}
}
var H = new Uint8Array([
	10,
	193,
	2,
	8,
	3,
	18,
	16,
	23,
	5,
	185,
	23,
	204,
	18,
	4,
	134,
	139,
	6,
	51,
	58,
	47,
	119,
	42,
	140,
	24,
	130,
	180,
	130,
	146,
	5,
	34,
	142,
	2,
	48,
	130,
	1,
	10,
	2,
	130,
	1,
	1,
	0,
	153,
	237,
	91,
	59,
	50,
	125,
	171,
	94,
	36,
	239,
	195,
	182,
	42,
	149,
	181,
	152,
	82,
	10,
	213,
	188,
	203,
	55,
	80,
	62,
	6,
	69,
	184,
	20,
	216,
	118,
	184,
	223,
	64,
	81,
	4,
	65,
	173,
	140,
	227,
	173,
	177,
	27,
	184,
	140,
	78,
	114,
	90,
	94,
	74,
	158,
	7,
	149,
	41,
	29,
	88,
	88,
	64,
	35,
	167,
	225,
	175,
	14,
	56,
	169,
	18,
	121,
	57,
	48,
	8,
	97,
	11,
	111,
	21,
	140,
	135,
	140,
	126,
	33,
	191,
	251,
	254,
	234,
	119,
	225,
	1,
	158,
	30,
	87,
	129,
	232,
	164,
	95,
	70,
	38,
	61,
	20,
	230,
	14,
	128,
	88,
	168,
	96,
	122,
	220,
	224,
	79,
	172,
	132,
	87,
	177,
	55,
	168,
	214,
	124,
	205,
	235,
	51,
	112,
	93,
	152,
	58,
	33,
	251,
	78,
	236,
	189,
	74,
	16,
	202,
	71,
	73,
	12,
	164,
	126,
	170,
	93,
	67,
	130,
	24,
	221,
	186,
	241,
	202,
	222,
	51,
	146,
	241,
	61,
	111,
	251,
	100,
	66,
	253,
	49,
	225,
	191,
	64,
	176,
	198,
	4,
	209,
	196,
	186,
	76,
	149,
	32,
	164,
	191,
	151,
	238,
	189,
	96,
	146,
	154,
	252,
	238,
	245,
	91,
	186,
	245,
	100,
	226,
	208,
	231,
	108,
	215,
	197,
	92,
	115,
	160,
	130,
	185,
	150,
	18,
	11,
	131,
	89,
	237,
	206,
	36,
	112,
	112,
	130,
	104,
	13,
	111,
	103,
	198,
	216,
	44,
	74,
	197,
	243,
	19,
	68,
	144,
	167,
	78,
	236,
	55,
	175,
	75,
	47,
	1,
	12,
	89,
	232,
	40,
	67,
	226,
	88,
	47,
	11,
	107,
	159,
	93,
	176,
	252,
	94,
	110,
	223,
	100,
	251,
	211,
	8,
	180,
	113,
	27,
	207,
	18,
	80,
	1,
	156,
	159,
	90,
	9,
	2,
	3,
	1,
	0,
	1,
	58,
	20,
	108,
	105,
	99,
	101,
	110,
	115,
	101,
	46,
	119,
	105,
	100,
	101,
	118,
	105,
	110,
	101,
	46,
	99,
	111,
	109,
	18,
	128,
	3,
	174,
	52,
	115,
	20,
	181,
	168,
	53,
	41,
	127,
	39,
	19,
	136,
	251,
	123,
	184,
	203,
	82,
	119,
	210,
	73,
	130,
	60,
	221,
	209,
	218,
	48,
	185,
	51,
	57,
	81,
	30,
	179,
	204,
	189,
	234,
	4,
	185,
	68,
	185,
	39,
	193,
	33,
	52,
	110,
	253,
	189,
	234,
	201,
	212,
	19,
	145,
	126,
	110,
	193,
	118,
	161,
	4,
	56,
	70,
	10,
	80,
	59,
	193,
	149,
	43,
	155,
	164,
	228,
	206,
	15,
	196,
	191,
	194,
	10,
	152,
	8,
	170,
	175,
	75,
	252,
	209,
	156,
	29,
	207,
	205,
	245,
	116,
	204,
	172,
	40,
	209,
	180,
	16,
	65,
	108,
	249,
	222,
	136,
	4,
	48,
	28,
	189,
	179,
	52,
	202,
	252,
	208,
	212,
	9,
	120,
	66,
	58,
	100,
	46,
	84,
	97,
	61,
	240,
	175,
	207,
	150,
	202,
	74,
	146,
	73,
	216,
	85,
	228,
	43,
	58,
	112,
	62,
	241,
	118,
	127,
	106,
	155,
	211,
	109,
	107,
	248,
	43,
	231,
	107,
	191,
	12,
	186,
	79,
	222,
	89,
	210,
	171,
	204,
	118,
	254,
	182,
	66,
	71,
	184,
	92,
	67,
	31,
	188,
	165,
	34,
	102,
	182,
	25,
	252,
	54,
	151,
	149,
	67,
	252,
	169,
	203,
	189,
	187,
	250,
	250,
	14,
	26,
	85,
	231,
	85,
	163,
	199,
	188,
	230,
	85,
	249,
	100,
	111,
	88,
	42,
	185,
	207,
	112,
	170,
	8,
	185,
	121,
	248,
	103,
	246,
	58,
	11,
	43,
	127,
	219,
	54,
	44,
	91,
	196,
	236,
	213,
	85,
	216,
	91,
	202,
	169,
	197,
	147,
	195,
	131,
	200,
	87,
	212,
	157,
	170,
	183,
	126,
	64,
	183,
	133,
	29,
	223,
	210,
	73,
	152,
	128,
	142,
	53,
	178,
	88,
	231,
	93,
	120,
	234,
	192,
	202,
	22,
	247,
	4,
	115,
	4,
	194,
	13,
	147,
	237,
	228,
	232,
	255,
	28,
	111,
	23,
	230,
	36,
	62,
	63,
	61,
	168,
	252,
	23,
	9,
	135,
	14,
	196,
	95,
	186,
	130,
	58,
	38,
	63,
	12,
	239,
	161,
	247,
	9,
	59,
	25,
	9,
	146,
	131,
	38,
	51,
	55,
	5,
	4,
	58,
	41,
	189,
	166,
	249,
	180,
	52,
	44,
	200,
	223,
	84,
	60,
	177,
	161,
	24,
	47,
	124,
	95,
	255,
	51,
	241,
	4,
	144,
	250,
	202,
	91,
	37,
	54,
	11,
	118,
	1,
	94,
	156,
	90,
	6,
	171,
	142,
	224,
	47,
	0,
	210,
	232,
	213,
	152,
	97,
	4,
	170,
	204,
	77,
	212,
	117,
	253,
	150,
	238,
	156,
	228,
	227,
	38,
	242,
	27,
	131,
	199,
	5,
	133,
	119,
	179,
	135,
	50,
	205,
	218,
	188,
	106,
	107,
	237,
	19,
	251,
	13,
	73,
	211,
	138,
	69,
	235,
	135,
	165,
	244
]), U = class e extends x {
	static #e = 250;
	static #t = .25;
	#n = 1;
	#r = null;
	#i = !1;
	#a = null;
	#o = null;
	#s = void 0;
	#c = !0;
	#l;
	#u = S();
	#d;
	#f = !1;
	#p;
	#m;
	#h = !1;
	#g = null;
	#_;
	#v;
	#y;
	#b = !1;
	name = "shakaPlayer";
	constructor() {
		super(), this.playbackState = "IDLE", this.#l = this.#N(), n("outputDevicesEnabled") && (async () => {
			B = (await import("./output-devices-DLDX8cVL.js")).outputDevices;
		})();
		let e = (e) => {
			if (!e) return !1;
			let t = e.target;
			return t instanceof HTMLMediaElement ? t !== this.#E() : t instanceof C.default.Player ? t !== this.#D() : !0;
		}, t = (t) => {
			e(t) || (this.mediaElement && !this.mediaElement.paused && (this.playbackState = "PLAYING"), t?.target === this.#E() && this.#h && this.#g && !this.#i && this.#o == null && this.#F());
		}, r = (t) => {
			if (e(t)) return;
			let n = t.type === "buffering" && this.mediaElement?.networkState === HTMLMediaElement.NETWORK_LOADING;
			(this.mediaElement?.paused || n) && (this.playbackState = "STALLED");
		}, o = (t) => {
			e(t) || (async () => {
				this.mediaElement && this.preloadedStreamingSessionId && this.mediaElement.currentTime === this.mediaElement.duration && (await i(1e3), this.mediaElement && this.mediaElement.currentTime !== this.mediaElement.duration) || (this.playbackState = "NOT_PLAYING");
			})().catch(console.error);
		}, s = (e) => {
			let t = e.target, n = t === this.#E();
			if (n && t.readyState > HTMLMediaElement.HAVE_NOTHING && (this.currentTime = t.currentTime), n && this.#g && this.#h) {
				let e = t.duration - t.currentTime, { startBeforeEndS: n } = this.#A();
				!this.#i && !t.paused && e <= n && e > 0 && this.#z().catch(console.error);
			}
		}, c = (e) => {
			this.currentStreamingSessionId && e.target instanceof HTMLMediaElement && e.target === this.#E() && a.overwriteDuration(this.currentStreamingSessionId, e.target.duration);
		}, l = (e) => {
			let t = e.target;
			s(e);
			let n = t === d, r = n ? this.#p : this.#m;
			if (r) {
				let e = this.currentStreamingSessionId === r;
				if (e && this.#i) {
					this.debugLog(`Active track ended mid-crossfade (session: ${r}) -- letting #completeTransition finalize`);
					return;
				}
				if (t.readyState > HTMLMediaElement.HAVE_NOTHING && (this.currentTime = t.currentTime), this.debugLog(`Ended event from player ${n ? 1 : 2} (session: ${r})`), e) this.finishCurrentMediaProduct("completed");
				else {
					let e = this.playbackState, t = this.currentStreamingSessionId;
					this.currentStreamingSessionId = r, this.finishCurrentMediaProduct("completed", !0), this.currentStreamingSessionId = t, this.playbackState = e;
					let n = this.#E();
					n && n.readyState > HTMLMediaElement.HAVE_NOTHING && (this.currentTime = n.currentTime);
				}
				n ? this.#p = void 0 : this.#m = void 0;
			}
		}, u = (e) => this.#u.handleError(e), f = (t) => {
			e(t) || (this.currentTime = this.mediaElement ? this.mediaElement.currentTime : 0, this.#f && (this.#f = !1, this.seekEnd(this.currentTime)));
		};
		this.#d = {
			durationChangeHandler: c,
			endedHandler: l,
			errorHandler: u,
			pauseHandler: o,
			playHandler: t,
			playingHandler: (n) => {
				!e(n) && this.mediaElement && !this.mediaElement.paused && this.mediaProductActuallyStarted(this.currentStreamingSessionId), t(n);
			},
			seekedHandler: f,
			stalledHandler: r,
			timeUpdateHandler: s,
			waitingHandler: r
		}, this.#_ = {
			bufferingHandler: (e) => {
				e.buffering ? r(e) : this.hasStarted() && t(e);
			},
			errorHandler: (e) => this.#j(e),
			loadedHandler: o,
			stallDetectedHandler: r
		};
	}
	#x() {
		this.#a != null && (clearTimeout(this.#a), this.#a = null), this.#r != null && (clearTimeout(this.#r), this.#r = null), this.#o != null && (clearTimeout(this.#o), this.#o = null);
	}
	#S(e, t, n) {
		if (n !== void 0 && n !== this.#s) return;
		this.#s = void 0, this.#x(), this.debugLog("Crossfade complete - swapping active player");
		let r = this.#E(), i = this.#n === 1 ? this.#p : this.#m;
		if (i) {
			let e = this.playbackState, t = this.currentStreamingSessionId;
			this.currentTime = r.currentTime, this.currentStreamingSessionId = i, this.finishCurrentMediaProduct("completed", !0), this.currentStreamingSessionId = t, this.playbackState = e, this.#n === 1 ? this.#p = void 0 : this.#m = void 0;
		}
		r.volume = 0;
		try {
			r.pause();
		} catch {}
		this.#n = this.#n === 1 ? 2 : 1, this.currentTime = e.currentTime, this.currentStreamingSessionId = t.streamInfo.streamingSessionId, this.preloadedStreamingSessionId = void 0, this.startAssetPosition = 0;
		let s = Number.isFinite(e.duration) ? e.duration : t.streamInfo.duration ?? 0, c = e.currentTime, l = y({
			assetPosition: c,
			duration: s,
			playbackInfo: t.playbackInfo,
			streamInfo: t.streamInfo
		});
		a.saveMediaProductTransition(t.streamInfo.streamingSessionId, {
			mediaProduct: t.mediaProduct,
			playbackContext: l
		}), this.debugLog("Media product transition saved for track"), o.dispatchEvent(b(t.mediaProduct, l)), h.get("streaming_metrics:playback_statistics:idealStartTimestamp", t.streamInfo.streamingSessionId) === void 0 && h.mark("streaming_metrics:playback_statistics:idealStartTimestamp", t.streamInfo.streamingSessionId), e.paused || this.mediaProductActuallyStarted(t.streamInfo.streamingSessionId), this.mediaProductStarted(t.streamInfo.streamingSessionId), this.debugLog("Transition complete! Active player is now:", this.#n), this.#i = !1;
	}
	async #C(e) {
		if ("Cypress" in window) return;
		let t = await C.default.Player.probeSupport();
		if (t.drm["com.widevine.alpha"]) {
			this.debugLog("Configuring widevine DRM."), e.configure({ drm: {
				advanced: { "com.widevine.alpha": {
					audioRobustness: ["SW_SECURE_CRYPTO"],
					serverCertificate: H,
					videoRobustness: ["SW_SECURE_CRYPTO"]
				} },
				servers: { "com.widevine.alpha": "https://api.tidal.com/v2/widevine" }
			} });
			return;
		}
		if (t.drm["com.apple.fps.1_0"]) {
			this.debugLog("Configuring fairplay DRM."), C.default.polyfill.PatchedMediaKeysApple.install();
			let t = await j();
			e.configure({ drm: {
				advanced: { "com.apple.fps.1_0": {
					serverCertificate: t,
					serverCertificateUri: "https://fp.fa.tidal.com/certificate"
				} },
				initDataTransform: C.default.drm.FairPlay.verimatrixInitDataTransform,
				servers: { "com.apple.fps.1_0": "https://fp.fa.tidal.com/license" }
			} });
			return;
		}
	}
	async #w(e) {
		await C.default.drm.FairPlay.isFairPlaySupported() && e && (e.getConfiguration().streaming.preferNativeHls !== !0 && e.configure("streaming.preferNativeHls", !0), e.getConfiguration().streaming.useNativeHlsForFairPlay !== !0 && e.configure("streaming.useNativeHlsForFairPlay", !0), await e.unload(!0));
	}
	async #T(e, n) {
		this.debugLog("createShakaPlayer", e);
		let r = new C.default.Player();
		await r.attach(e), z(e), A(r, () => n === 1 ? this.#p : this.#m, () => this.#n === n);
		let i = await C.default.drm.FairPlay.isFairPlaySupported(), a = {
			backoffFactor: 2,
			baseDelay: 1e3,
			fuzzFactor: .5,
			maxAttempts: 5,
			timeout: 5e3
		};
		r.configure({
			abr: { enabled: !0 },
			drm: { retryParameters: a },
			manifest: {
				defaultPresentationDelay: 0,
				disableText: !0,
				disableThumbnails: !0,
				retryParameters: a
			},
			streaming: {
				bufferBehind: 40,
				bufferingGoal: 40,
				preferNativeHls: i,
				retryParameters: a,
				useNativeHlsForFairPlay: i
			}
		});
		try {
			await this.#C(r);
		} catch {
			this.finishCurrentMediaProduct("error");
			return;
		}
		return r.getNetworkingEngine()?.registerRequestFilter(async (e, r, i) => {
			if (e === C.default.net.NetworkingEngine.RequestType.LICENSE) {
				let e = i?.isPreload ?? n !== this.#n ? this.preloadedStreamingSessionId ?? this.currentStreamingSessionId : this.currentStreamingSessionId;
				h.mark("streaming_metrics:drm_license_fetch:startTimestamp", e), r.headers["Content-Type"] = "application/octet-stream";
				let { token: a } = await t.credentialsProvider.getCredentials();
				a && (r.headers.authorization = `Bearer ${a}`);
			}
		}), r.getNetworkingEngine()?.registerResponseFilter((e, t, r) => {
			let i = r?.isPreload ?? n !== this.#n ? this.preloadedStreamingSessionId ?? this.currentStreamingSessionId : this.currentStreamingSessionId;
			e === C.default.net.NetworkingEngine.RequestType.LICENSE && i && (h.mark("streaming_metrics:drm_license_fetch:endTimestamp", i), g({
				cdm: V(t.uri),
				cdmVersion: null,
				streamingSessionId: i
			}).catch(console.error), p([m({
				endReason: "COMPLETE",
				endTimestamp: h.get("streaming_metrics:drm_license_fetch:endTimestamp", i),
				errorCode: null,
				errorMessage: null,
				startTimestamp: h.get("streaming_metrics:drm_license_fetch:startTimestamp", i),
				streamingSessionId: i
			})]).catch(console.error), h.clear("streaming_metrics:drm_license_fetch:endTimestamp", i), h.clear("streaming_metrics:drm_license_fetch:startTimestamp", i));
		}), this.#I(r, !0), this.#P(e, !0), r;
	}
	#E() {
		return this.#n === 1 ? d : l;
	}
	#D() {
		return this.#n === 1 ? this.#v : this.#y;
	}
	#O() {
		return this.#n === 1 ? l : d;
	}
	#k() {
		return this.#n === 1 ? this.#y : this.#v;
	}
	#A() {
		let t = n("crossfadeInMs");
		return t > 0 ? {
			crossfadeDurationMs: t,
			startBeforeEndS: t / 1e3
		} : {
			crossfadeDurationMs: e.#e,
			startBeforeEndS: e.#t
		};
	}
	#j(e) {
		if (this.#c) return;
		let t = e.target instanceof C.default.Player && e.target !== this.#D(), n = e.detail, i = `S${n.code}`;
		switch (n.code) {
			case C.default.util.Error.Code.LICENSE_REQUEST_FAILED: {
				let e = t ? this.preloadedStreamingSessionId ?? this.currentStreamingSessionId : this.currentStreamingSessionId;
				e && (h.mark("streaming_metrics:drm_license_fetch:endTimestamp", e), p([m({
					endReason: "ERROR",
					endTimestamp: h.get("streaming_metrics:drm_license_fetch:endTimestamp", e),
					errorCode: i,
					errorMessage: JSON.stringify(n),
					startTimestamp: h.get("streaming_metrics:drm_license_fetch:startTimestamp", e),
					streamingSessionId: e
				})]).catch(console.error), h.clear("streaming_metrics:drm_license_fetch:endTimestamp", e), h.clear("streaming_metrics:drm_license_fetch:startTimestamp", e));
				break;
			}
			case C.default.util.Error.Code.LOAD_INTERRUPTED: return;
			case C.default.util.Error.Code.SRC_EQUALS_PRELOAD_NOT_SUPPORTED: return;
			case C.default.util.Error.Code.TIMEOUT: console.warn("Shaka: TIMEOUT"), console.warn("Shaka: URI", n.data[0]), console.warn("Shaka: RequestType", n.data[1]);
		}
		let a = n.category === C.default.util.Error.Category.NETWORK;
		if (n.severity === C.default.util.Error.Severity.CRITICAL) {
			if (t) {
				this.debugLog("Critical error from inactive player, clearing preload:", i), this.#h = !1, this.unloadPreloadedMediaProduct().catch(console.error), o.dispatchError(new r(a ? "PENetwork" : "EUnexpected", i));
				return;
			}
			this.playbackState = "STALLED", this.mediaElement && this.mediaElement.pause(), this.currentStreamingSessionId && g({
				errorCode: i,
				errorMessage: JSON.stringify(n),
				streamingSessionId: this.currentStreamingSessionId
			}), o.dispatchError(new r(a ? "PENetwork" : "EUnexpected", i)), a || this.finishCurrentMediaProduct("error");
		}
		a && (this.#b = !0);
	}
	async #M({ assetPosition: e, assetUriOrPreloader: t, mediaProduct: n, playbackInfo: r, streamInfo: i }) {
		this.debugLog("loadAndDispatchMediaProductTransition"), this.currentTime = e;
		let s = this.#D(), c = this.#E();
		if (!s || !c) return;
		let l, u = new Promise((e) => {
			l = e;
		}), d = () => l();
		s.addEventListener("loaded", d, { once: !0 }), this.debugLog("Loading with", typeof t == "string" ? "URL" : "PreloadManager", "at position", e), this.currentStreamingSessionId = r.streamingSessionId, this.preloadedStreamingSessionId = void 0, this.#n === 1 ? this.#p = r.streamingSessionId : this.#m = r.streamingSessionId;
		let f, p = a.hasMediaProductTransition(r.streamingSessionId);
		if (p) f = a.getMediaProductTransition(r.streamingSessionId).playbackContext;
		else {
			let t = i.duration ?? 0;
			f = y({
				assetPosition: e,
				duration: t,
				playbackInfo: r,
				streamInfo: i
			}), a.saveMediaProductTransition(i.streamingSessionId, {
				mediaProduct: n,
				playbackContext: f
			});
		}
		let m = new AbortController(), h;
		p || (h = new Promise((e) => c.addEventListener("durationchange", (t) => {
			t.target instanceof HTMLMediaElement && e(t.target.duration);
		}, {
			once: !0,
			signal: m.signal
		})));
		try {
			await s.load(t, e), this.debugLog("Load completed successfully");
		} catch (e) {
			let t = e;
			console.error("Load failed:", t), this.#j(new CustomEvent("shaka-error", { detail: t })), s.removeEventListener("loaded", d), m.abort(), a.deleteSession(i.streamingSessionId);
			return;
		}
		if (h) {
			let t = await h;
			f = y({
				assetPosition: e,
				duration: t,
				playbackInfo: r,
				streamInfo: i
			}), a.saveMediaProductTransition(i.streamingSessionId, {
				mediaProduct: n,
				playbackContext: f
			});
		}
		await u, this.currentStreamingSessionId === i.streamingSessionId && o.dispatchEvent(b(n, f));
	}
	async #N() {
		this.debugLog("loadLibraries"), C.default.polyfill.installAll(), await u(), this.#v = await this.#T(d, 1), this.#y = await this.#T(l, 2), l.volume = 0, this.debugLog("Both Shaka players initialized for gapless playback");
	}
	#P(e, t) {
		this.debugLog("mediaElementEvents", t ? "adding to" : "removing from", e);
		let n = t ? "addEventListener" : "removeEventListener";
		e[n]("durationchange", this.#d.durationChangeHandler, { passive: !0 }), e[n]("play", this.#d.playHandler, { passive: !0 }), e[n]("playing", this.#d.playingHandler, { passive: !0 }), e[n]("timeupdate", this.#d.timeUpdateHandler, { passive: !0 }), e[n]("pause", this.#d.pauseHandler, { passive: !0 }), e[n]("ended", this.#d.endedHandler, { passive: !0 }), e[n]("error", this.#d.errorHandler, { passive: !0 }), e[n]("waiting", this.#d.waitingHandler, { passive: !0 }), e[n]("stalled", this.#d.stalledHandler, { passive: !0 }), e[n]("seeked", this.#d.seekedHandler, { passive: !0 });
	}
	#F() {
		this.#o != null && (clearTimeout(this.#o), this.#o = null);
		let e = this.#E(), t = e.duration;
		if (!Number.isFinite(t) || t <= 0) {
			this.debugLog("scheduleCrossfadeTrigger: invalid duration, skipping");
			return;
		}
		let n = e.playbackRate || 1, r = t - e.currentTime, { startBeforeEndS: i } = this.#A(), a = (r - i) * 1e3 / n;
		if (a <= 0) {
			if (e.paused) {
				this.debugLog("scheduleCrossfadeTrigger: inside trigger window but paused -- deferring to timeUpdateHandler");
				return;
			}
			this.debugLog("scheduleCrossfadeTrigger: inside trigger window -- firing now"), this.#z().catch(console.error);
			return;
		}
		this.#o = setTimeout(() => {
			this.#o = null;
			let { startBeforeEndS: t } = this.#A();
			if ((e.duration - e.currentTime - t) * 1e3 / (e.playbackRate || 1) > 0) {
				if (!this.#h || !this.#g || this.#i) {
					this.debugLog("scheduleCrossfadeTrigger: preload no longer valid -- not rescheduling");
					return;
				}
				if (e.paused) {
					this.debugLog("scheduleCrossfadeTrigger: paused while waiting -- deferring re-arm to play event");
					return;
				}
				this.debugLog("scheduleCrossfadeTrigger: no longer inside trigger window -- rescheduling"), this.#F();
				return;
			}
			this.#h && this.#g && !this.#i && !e.paused && e === this.#E() ? this.#z().catch(console.error) : this.debugLog("scheduleCrossfadeTrigger: guards failed, NOT starting");
		}, a);
	}
	#I(e, t) {
		this.debugLog("shakaEvents");
		let n = t ? "addEventListener" : "removeEventListener";
		e[n]("error", this.#_.errorHandler, !1), e[n]("buffering", this.#_.bufferingHandler, !1), e[n]("stalldetected", this.#_.stallDetectedHandler, !1), e[n]("loaded", this.#_.loadedHandler, !1);
	}
	async #L(e) {
		this.debugLog(`Starting crossfade transition (${e}ms)`);
		let t = this.#E(), n = this.#O(), r = this.#g;
		this.#h = !1, this.#g = null;
		let i = {};
		this.#s = i;
		let o = a.getStreamInfo(this.currentStreamingSessionId);
		try {
			n.currentTime = 0, n.volume = .001, await n.play(), n.volume = 0, this.mediaProductActuallyStarted(r.streamInfo.streamingSessionId);
		} catch (e) {
			this.debugLog("Error while starting crossfade", e);
			try {
				n.pause();
			} catch {}
			this.#x(), this.#i = !1, this.#s = void 0, this.unloadPreloadedMediaProduct().catch(console.error);
			return;
		}
		let s = performance.now(), c = () => {
			if (this.#s !== i) return;
			let a = performance.now() - s, l = Math.min(a / e, 1), u = Math.cos(l * Math.PI / 2), d = Math.sin(l * Math.PI / 2), f = o ? this.adjustedVolume(o) : t.volume, p = this.adjustedVolume(r.streamInfo);
			t.volume = Math.max(0, Math.min(1, f * u)), n.volume = Math.max(0, Math.min(1, p * d)), l < 1 ? this.#a = setTimeout(c, 16) : this.#S(n, r, i);
		};
		this.#r = setTimeout(() => {
			this.#s === i && (this.debugLog("Crossfade hit hard deadline -- forcing completion"), t.volume = 0, n.volume = this.adjustedVolume(r.streamInfo), this.#S(n, r, i));
		}, e + 200), c();
	}
	async #R() {
		this.debugLog("Starting instant transition (no fade)");
		let e = this.#O(), t = this.#g;
		this.#h = !1, this.#g = null;
		let n = {};
		this.#s = n;
		let r = this.adjustedVolume(t.streamInfo);
		try {
			e.currentTime = 0, e.volume = r, await e.play(), this.mediaProductActuallyStarted(t.streamInfo.streamingSessionId);
		} catch (e) {
			this.debugLog("Error while starting instant transition", e), this.#i = !1, this.#s = void 0, this.unloadPreloadedMediaProduct().catch(console.error);
			return;
		}
		this.#s === n && this.#S(e, t, n);
	}
	async #z({ instant: e = !1 } = {}) {
		if (this.#i || !this.#g || !this.#h) return;
		if (this.#i = !0, h.mark("streaming_metrics:playback_statistics:idealStartTimestamp", this.#g.streamInfo.streamingSessionId), e) {
			await this.#R();
			return;
		}
		let { crossfadeDurationMs: t } = this.#A(), n = this.#E(), r = n.playbackRate || 1, i = Math.max(0, (n.duration - n.currentTime) * 1e3 / r), a = Math.max(1, Math.min(t, i));
		await this.#L(a);
	}
	async #B(e) {
		return e.readyState > HTMLMediaElement.HAVE_NOTHING || new Promise((t) => {
			let n = !1, r = () => {
				e.removeEventListener("loadedmetadata", a), e.removeEventListener("loadeddata", a), e.removeEventListener("canplay", a), clearTimeout(o);
			}, i = (e) => {
				n || (n = !0, r(), t(e));
			}, a = () => i(!0), o = setTimeout(() => i(!1), 1e3);
			e.addEventListener("loadedmetadata", a, { once: !0 }), e.addEventListener("loadeddata", a, { once: !0 }), e.addEventListener("canplay", a, { once: !0 });
		});
	}
	getPosition() {
		return this.currentTime;
	}
	async load(e, t) {
		this.debugLog("load", e), await this.ready, this.currentTime = e.assetPosition, this.startAssetPosition = e.assetPosition, await this.reset(), this.#c = !1, await this.#w(this.#D()), await u();
		let { assetPosition: n, mediaProduct: r, playbackInfo: i, streamInfo: a } = e;
		this.currentStreamingSessionId = a.streamingSessionId, t === "explicit" && (this.playbackState = "NOT_PLAYING");
		let o = this.#E();
		if (!this.#D() || !o) return;
		this.#i && (this.#i = !1, this.#s = void 0), this.#x(), this.#h = !1, this.#g = null;
		let s = this.#O();
		return s.pause(), s.volume = 0, this.#M({
			assetPosition: n,
			assetUriOrPreloader: a.streamUrl,
			mediaProduct: r,
			playbackInfo: i,
			streamInfo: a
		});
	}
	get mediaElement() {
		return this.#E();
	}
	async next(e) {
		this.debugLog("next", e);
		let t = this.#k(), n = this.#O();
		if (!t || !n) {
			console.warn("Inactive Shaka instance or media element not initialized.");
			return;
		}
		this.#h = !1, this.#g = e, this.preloadedStreamingSessionId = e.streamInfo.streamingSessionId;
		let r = this.#n === 1 ? this.#m : this.#p;
		if (r) {
			this.debugLog(`Finalizing pending session ${r} on inactive player before preload`);
			let e = this.playbackState, t = this.currentStreamingSessionId, i = this.currentTime;
			n.readyState > HTMLMediaElement.HAVE_NOTHING && (this.currentTime = n.currentTime), this.currentStreamingSessionId = r, this.finishCurrentMediaProduct("completed", !0), this.currentStreamingSessionId = t, this.playbackState = e, this.currentTime = i;
		}
		this.#n === 1 ? this.#m = e.streamInfo.streamingSessionId : this.#p = e.streamInfo.streamingSessionId;
		let i = e.streamInfo.duration || 0, o = y({
			assetPosition: 0,
			duration: i,
			playbackInfo: e.playbackInfo,
			streamInfo: e.streamInfo
		});
		a.saveMediaProductTransition(e.streamInfo.streamingSessionId, {
			mediaProduct: e.mediaProduct,
			playbackContext: o
		}), this.debugLog("Loading next track in inactive player");
		try {
			if (await t.load(e.streamInfo.streamUrl), this.debugLog("Next track loaded in inactive player"), n.volume = 0, n.currentTime !== 0 && (n.currentTime = 0), !await this.#B(n)) throw Error(`Preloaded media element did not become ready after Shaka load (readyState=${n.readyState})`);
			this.debugLog("Next track loaded and ready in inactive player"), this.playbackState === "IDLE" && (this.playbackState = "NOT_PLAYING"), (!n.duration || isNaN(n.duration)) && await new Promise((e) => {
				let t = () => {
					clearTimeout(r), e();
				}, r = setTimeout(() => {
					n.removeEventListener("durationchange", t), this.debugLog("next(): durationchange did not fire within 3000ms -- falling back to payload duration"), e();
				}, 3e3);
				n.addEventListener("durationchange", t, { once: !0 });
			});
			let r = n.duration || e.streamInfo.duration || 0, i = y({
				assetPosition: 0,
				duration: r,
				playbackInfo: e.playbackInfo,
				streamInfo: e.streamInfo
			});
			if (a.saveMediaProductTransition(e.streamInfo.streamingSessionId, {
				mediaProduct: e.mediaProduct,
				playbackContext: i
			}), this.debugLog("Media product transition saved for next track"), this.preloadedStreamingSessionId !== e.streamInfo.streamingSessionId) {
				this.debugLog(`next(): preload superseded during load (${e.streamInfo.streamingSessionId} -> ${this.preloadedStreamingSessionId ?? "none"}) -- not arming preload`);
				return;
			}
			this.#h = !0, this.#c = !1, this.#F();
		} catch (e) {
			console.error("Failed to load next track:", e);
			try {
				await t.unload(!0);
			} catch {}
			this.#h = !1, this.#g = null, this.cleanUpStoredPreloadInfo(), this.#n === 1 ? this.#m = void 0 : this.#p = void 0;
		}
	}
	pause() {
		this.debugLog("pause"), this.mediaElement && this.mediaElement.pause();
	}
	async play() {
		if (this.debugLog("play"), await this.maybeHardReload(), this.#b) {
			let e = this.#D()?.retryStreaming();
			if (this.#b = !e, !e) {
				this.playbackState = "NOT_PLAYING", this.finishCurrentMediaProduct("error");
				return;
			}
		}
		if (this.playbackState === "IDLE") return this.debugLog("is IDLE, returning early"), Promise.resolve();
		let e = this.#E();
		e && "setSinkId" in e && await this.updateOutputDevice(), this.mediaProductStarted(this.currentStreamingSessionId), this.setStateToXIfNotYInZMs(1e3, "PLAYING", "STALLED"), await this.mediaElement?.play();
		let t = this.#D()?.getVariantTracks()?.find((e) => e.active);
		D(this.currentStreamingSessionId, t);
	}
	async playbackEngineEndedHandler(e) {
		if (this.isActivePlayer) {
			let { reason: t } = e.detail;
			t === "completed" && (this.debugLog("Track ended - checking for next item"), this.#g && this.#h && !this.#i ? (this.debugLog("Transition missed - swapping immediately"), await this.#z({ instant: !0 })) : this.#h && this.hasNextItem() ? (await this.skipToPreloadedMediaProduct(), await this.play()) : (s.preloadedStreamingSessionId ? this.debugLog(`Switching player from ${this.name} to ${s.preloadPlayer?.name}`) : this.debugLog("No next item queued."), this.playbackState = "NOT_PLAYING"));
		}
	}
	get ready() {
		return this.#l;
	}
	async reset({ keepPreload: e } = { keepPreload: !1 }) {
		if (this.debugLog("reset"), this.#u.reset(), this.#c) return;
		let t = !e && !!this.preloadedStreamingSessionId;
		e || await this.unloadPreloadedMediaProduct({ initializeMediaSource: !0 }), this.playbackState !== "IDLE" && this.finishCurrentMediaProduct("skip"), this.playbackState = "IDLE", this.detachPlaybackEngineEndedHandler(), this.currentStreamingSessionId = void 0, this.#f = !1, e || (this.preloadedStreamingSessionId = void 0, this.#h = !1, this.#g = null), this.#i && (this.#x(), this.#i = !1, this.#s = void 0), this.#c = !0;
		let n = [], r = this.#D(), i = this.#k();
		r && n.push(r.unload(!0)), !e && !t && i && n.push(i.unload(!0)), e ? this.#n === 1 ? this.#p = void 0 : this.#m = void 0 : (d.volume = 1, l.volume = 0, this.#n = 1, this.#p = void 0, this.#m = void 0), await Promise.all(n);
	}
	seek(e) {
		this.debugLog("seek", e);
		let { mediaElement: t } = this;
		if (!t) {
			this.debugLog("No media element available for seeking");
			return;
		}
		this.seekStart(this.currentTime), this.#f = !0, this.currentTime = e;
		let n = e;
		return "fastSeek" in t ? t.fastSeek(n) : t.currentTime = n, new Promise((e) => {
			t.addEventListener("seeked", () => e(t.currentTime), { once: !0 });
		});
	}
	async skipToPreloadedMediaProduct() {
		if (this.debugLog("skipToPreloadedMediaProduct", this.preloadedStreamingSessionId), !this.preloadedStreamingSessionId) return Promise.reject("Nothing preloaded.");
		let e = this.#g;
		if (!e) return Promise.reject("Preloaded payload not found.");
		let t = a.getMediaProductTransition(this.preloadedStreamingSessionId);
		t && (e.mediaProduct = t.mediaProduct);
		let n = this.#O(), r = this.#E();
		r.pause(), r.volume = 0, this.playbackState = "NOT_PLAYING", this.#x(), this.#h = !1, this.#g = null, this.#S(n, e);
	}
	togglePlayback() {
		this.debugLog("togglePlayback");
		let { mediaElement: e } = this;
		e && (e.paused ? e.play().catch(console.error) : e.pause());
	}
	async unloadPreloadedMediaProduct({ initializeMediaSource: e = !1 } = {}) {
		if (this.debugLog("unloadPreloadedMediaProduct", this.preloadedStreamingSessionId), !this.preloadedStreamingSessionId) return;
		this.cleanUpStoredPreloadInfo(), this.#x(), this.#g = null, this.#h = !1;
		let t = this.#k(), n = this.#O();
		if (t) {
			try {
				await t.unload(e);
			} catch (e) {
				this.debugLog("inactivePlayer.unload() rejected (ignored)", e);
			}
			n.volume = 0;
		}
	}
	async updateOutputDevice() {
		if (!B) return;
		if (B && !B.activeDevice || !n("outputDevicesEnabled")) return Promise.resolve();
		let e = B.activeDevice.webDeviceId;
		if (e && typeof d.setSinkId == "function") {
			this.outputDeviceType = B.activeDevice.type;
			try {
				await Promise.all([d.setSinkId(e), l.setSinkId(e)]), o.dispatchEvent(v(B.activeDevice.id));
			} catch (e) {
				console.error(e);
			}
		}
	}
	get volume() {
		return n("desiredVolumeLevel");
	}
	set volume(e) {
		this.debugLog("Setting volume to", e), this.mediaElement && (this.mediaElement.volume = e);
	}
};
//#endregion
export { U as default };

