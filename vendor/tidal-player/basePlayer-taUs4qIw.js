import { d as e, l as t, n, r, t as i, u as a } from "./state-BujoNwcN.js";
import { i as o } from "./pushkin-C5TU0Pwc.js";
import { a as s, f as c, h as l, i as u, l as d, m as f, o as p, p as m, r as h, s as g, t as _ } from "./load-uTL4eiru.js";
//#region src/api/event/media-product-transition.ts
function v(e, t) {
	return new CustomEvent("media-product-transition", { detail: {
		mediaProduct: e,
		playbackContext: t
	} });
}
//#endregion
//#region src/internal/helpers/compose-playback-context.ts
var y = ({ assetPosition: e, duration: t, playbackInfo: n, streamInfo: r }) => ({
	actualAssetPresentation: n.assetPresentation,
	actualAudioMode: "audioMode" in n ? n.audioMode : null,
	actualAudioQuality: "audioQuality" in n ? n.audioQuality : null,
	actualDuration: t,
	actualProductId: String("videoId" in n ? n.videoId : n.trackId),
	actualStreamType: "streamType" in n ? n.streamType : null,
	actualVideoQuality: "videoQuality" in n ? n.videoQuality : null,
	assetPosition: e,
	bandwidth: null,
	bitDepth: r.bitDepth ?? null,
	codec: r.codec ?? null,
	playbackSessionId: r.streamingSessionId,
	previewReason: n.previewReason ?? void 0,
	sampleRate: r.sampleRate ?? null
});
//#endregion
//#region src/api/event/ended.ts
function b(e, t) {
	return new CustomEvent("ended", { detail: {
		mediaProduct: t,
		reason: e
	} });
}
//#endregion
//#region src/api/event/playback-state-change.ts
function x(e) {
	return new CustomEvent("playback-state-change", { detail: { state: e } });
}
//#endregion
//#region src/api/event/preload-request.ts
function S() {
	return new CustomEvent("preload-request");
}
//#endregion
//#region src/internal/helpers/normalize-volume.ts
function C(e) {
	return Math.min(10 ** ((4 + e) / 20), 1);
}
//#endregion
//#region src/player/basePlayer.ts
var w = 500;
function T(e) {
	if (typeof e == "string") return E(e);
	if (!e || typeof e != "object") return e;
	if (e instanceof Error) return {
		message: e.message,
		name: e.name,
		stack: e.stack
	};
	if (e instanceof Event || e instanceof Element) return e;
	if (Array.isArray(e)) return e.map(T);
	let t = {};
	for (let [n, r] of Object.entries(e)) {
		if (D(n)) {
			t[n] = typeof r == "string" ? `[redacted ${n}, ${r.length} chars]` : `[redacted ${n}]`;
			continue;
		}
		t[n] = T(r);
	}
	return t;
}
function E(e) {
	if (e.startsWith("data:")) return `[redacted data URL, ${e.length} chars]`;
	if (e.startsWith("http://") || e.startsWith("https://")) {
		let t = e.indexOf("?");
		if (t !== -1) return `${e.slice(0, t)}?[redacted query, ${e.length - t - 1} chars]`;
	}
	return e.length > w ? `${e.slice(0, w)}...[truncated ${e.length} chars]` : e;
}
function D(e) {
	return e === "manifest" || e === "streamUrl" || /token/i.test(e);
}
function O(e) {
	switch (e) {
		case "completed": return "COMPLETE";
		case "error": return "ERROR";
		default: return "OTHER";
	}
}
var k = class {
	#e;
	#t;
	#n;
	#r = void 0;
	#i;
	#a = "IDLE";
	#o;
	#s;
	name;
	constructor() {
		a.addEventListener("desiredVolumeLevel", () => {
			this.isActivePlayer && this.updateVolumeLevel();
		});
	}
	#c() {
		let t = e("crossfadeInMs") / 1e3;
		this.duration && Math.abs(this.#t - this.duration + t) <= 15 && this.#r === !1 && (this.debugLog("maybeDispatchPreloadRequest", {
			crossfadeInS: t,
			currentTime: this.#t,
			duration: this.duration
		}, Math.abs(this.#t - this.duration + t)), this.#r = !0, r.dispatchEvent(S()));
	}
	#l({ endAssetPosition: e, endReason: t, isSeamlessTransition: a = !1, streamingSessionId: o }) {
		this.debugLog("mediaProductEnded"), !a && i.preloadedStreamingSessionId && d.mark("streaming_metrics:playback_statistics:idealStartTimestamp", i.preloadedStreamingSessionId);
		let s = n.getMediaProductTransition(o);
		!a && s && r.dispatchEvent(b(t, s.mediaProduct)), this.eventTrackingStreamingEnded(o, {
			endAssetPosition: e,
			endReason: t
		}), n.deleteSession(o), this.currentStreamingSessionId === o && (this.currentStreamingSessionId = void 0), a || this.updateVolumeLevelForNextProduct();
	}
	adjustedVolume(t) {
		let n = e("desiredVolumeLevel"), r = e("loudnessNormalizationMode"), i = n;
		return r === "ALBUM" && t.albumReplayGain && (i *= C(t.albumReplayGain)), r === "TRACK" && t.trackReplayGain && (i *= C(t.trackReplayGain)), this.debugLog("adjustedVolume", `Volume adjusted from ${n} to ${i}`), parseFloat(i.toFixed(2));
	}
	attachPlaybackEngineEndedHandler() {
		this.#n || (this.#n = this.playbackEngineEndedHandler.bind(this), r.addEventListener("ended", this.#n));
	}
	cleanUpStoredPreloadInfo() {
		this.preloadedStreamingSessionId && this.preloadedStreamingSessionId !== this.currentStreamingSessionId && (n.deleteSession(this.preloadedStreamingSessionId), this.preloadedStreamingSessionId = void 0);
	}
	get currentMediaProduct() {
		return n.getMediaProductTransition(this.currentStreamingSessionId)?.mediaProduct ?? null;
	}
	set currentStreamingSessionId(e) {
		this.#e = e;
	}
	get currentStreamingSessionId() {
		return this.#e;
	}
	set currentTime(e) {
		this.#t = e, this.#c();
	}
	get currentTime() {
		return this.#t;
	}
	debugLog(...e) {
		(document.location.hostname === "localhost" || document.location.hostname === "dev.tidal.com") && document.location.hash.includes("debug") && console.debug(`[%cPlayerSDK${this.name ? `%c${i.activePlayer?.name === this.name ? "⚯" : "⚮"}%c` + this.name : ""}${this.#e ? "%c::%c" + this.#e?.split("-").pop() : ""}%c]`, "color:#00d6ff", ...this.name ? ["color:inherit", "color:#b7fa34"] : [], ...this.#e ? ["color:inherit", "color:#d947ff"] : [], "color:inherit", ...e.map(T));
	}
	detachPlaybackEngineEndedHandler() {
		this.#n &&= (r.removeEventListener("ended", this.#n), void 0);
	}
	get duration() {
		let e = n.getMediaProductTransition(this.currentStreamingSessionId);
		return e ? e.playbackContext.actualDuration : null;
	}
	eventTrackingStreamingEnded(e, { endAssetPosition: t, endReason: n }) {
		let r = o.now();
		h([s({
			endAssetPosition: t,
			endTimestamp: r,
			streamingSessionId: e
		})]).catch(console.error).finally(() => {
			c([f({
				endReason: O(n),
				endTimestamp: r,
				streamingSessionId: e
			}), m({
				streamingSessionId: e,
				timestamp: r
			})]).catch(console.error);
		});
	}
	eventTrackingStreamingStarted(e) {
		if (!e) return;
		f({
			idealStartTimestamp: d.get("streaming_metrics:playback_statistics:idealStartTimestamp", e) ?? null,
			outputDevice: this.#i,
			streamingSessionId: e
		}).catch(console.error), d.clear("streaming_metrics:playback_statistics:idealStartTimestamp", e);
		let t = n.getMediaProductTransition(e);
		if (!t) {
			n.hasStartedStreamInfo(e) ? console.error(`A media product transition for streaming session #${e} has not been saved and could thus not be found for play log reporting.`) : (n.deleteStreamInfo(e), console.warn(`Streaming session #${e} has been discarded due to a new load. This could mean you have a bug in your code where you call load on Player more than once time in a very short time frame.`));
			return;
		}
		let { mediaProduct: r, playbackContext: i } = t, a = o.now();
		s({
			actualAssetPresentation: i.actualAssetPresentation,
			actualAudioMode: "actualAudioMode" in i ? i.actualAudioMode : null,
			actualProductId: i.actualProductId,
			actualQuality: i.actualAudioQuality || i.actualVideoQuality,
			extras: r.extras,
			isPostPaywall: g(i.actualAssetPresentation, r),
			playbackSessionId: e,
			productType: u(r.productType),
			requestedProductId: r.productId,
			sourceId: r.sourceId,
			sourceType: r.sourceType,
			startAssetPosition: this.startAssetPosition,
			startTimestamp: a,
			streamingSessionId: e
		}).catch(console.error);
	}
	get expired() {
		let e = n.getStreamInfo(this.currentStreamingSessionId);
		return e ? e.expires <= Date.now() : !1;
	}
	finishCurrentMediaProduct(e, t = !1) {
		if (!this.hasStarted()) return;
		let r = this.#e, i = r ? n.hasStreamInfo(r) : !1;
		!t && !this.preloadedStreamingSessionId && (this.playbackState = "IDLE"), r && i && this.#l({
			endAssetPosition: this.currentTime,
			endReason: e,
			isSeamlessTransition: t,
			streamingSessionId: r
		});
	}
	getPosition() {
		return 0;
	}
	async hardReload(e, t) {
		return this.currentStreamingSessionId && this.finishCurrentMediaProduct("skip"), _(e, t);
	}
	hasNextItem() {
		return this.preloadedStreamingSessionId;
	}
	hasStarted() {
		return this.currentStreamingSessionId && n.hasStartedStreamInfo(this.currentStreamingSessionId);
	}
	get isActivePlayer() {
		return i.activePlayer && this.name === i.activePlayer.name;
	}
	load(e, t) {
		return Promise.resolve();
	}
	async maybeHardReload() {
		let e = this.prefetched || this.expired;
		return this.currentMediaProduct && e ? (await this.hardReload(this.currentMediaProduct, this.currentTime), !0) : !1;
	}
	mediaProductActuallyStarted(e) {
		!e || n.hasReportedActualStart(e) || (this.debugLog("mediaProductActuallyStarted"), n.setReportedActualStart(e), f({
			actualStartTimestamp: o.now(),
			streamingSessionId: e
		}).catch(console.error));
	}
	mediaProductStarted(e) {
		!e || n.hasStartedStreamInfo(e) || (this.debugLog("mediaProductStarted"), this.eventTrackingStreamingStarted(e), n.setStartedStreamInfo(e), this.updateVolumeLevel(), this.#r = !1, this.preloadedStreamingSessionId === e && (this.preloadedStreamingSessionId = void 0, this.unloadPreloadedMediaProduct().catch(console.error)), this.attachPlaybackEngineEndedHandler());
	}
	next(e) {
		return Promise.resolve();
	}
	get nextItem() {
		if (this.preloadedStreamingSessionId) return n.getMediaProductTransition(this.preloadedStreamingSessionId);
	}
	set outputDeviceType(e) {
		this.#i = e ? l(e) : void 0;
	}
	overwriteMediaProduct(e, t) {
		let r = n.getMediaProductTransition(e);
		if (r) {
			n.deleteMediaProductTransition(e);
			let i = {
				mediaProduct: {
					...r.mediaProduct,
					...t
				},
				playbackContext: { ...r.playbackContext }
			};
			n.saveMediaProductTransition(e, i);
		}
	}
	pause() {}
	play() {
		return Promise.resolve();
	}
	playbackEngineEndedHandler(e) {
		return Promise.resolve();
	}
	set playbackState(e) {
		let t = this.#a;
		if (t === e || !this.currentStreamingSessionId) return;
		let n = (n, r) => t === n && r === e;
		switch (!0) {
			case n("NOT_PLAYING", "STALLED"):
			case n("IDLE", "STALLED"): return;
			case n("PLAYING", "NOT_PLAYING"):
			case n("PLAYING", "IDLE"):
				this.duration && this.currentTime < this.duration && p(this.currentStreamingSessionId, {
					actionType: "PLAYBACK_STOP",
					assetPosition: this.currentTime,
					timestamp: o.now()
				}).catch(console.error);
				break;
			case n("IDLE", "PLAYING"):
			case n("NOT_PLAYING", "PLAYING"): this.currentTime !== this.startAssetPosition && p(this.currentStreamingSessionId, {
				actionType: "PLAYBACK_START",
				assetPosition: this.currentTime,
				timestamp: o.now()
			}).catch(console.error);
		}
		this.#a = e, this.debugLog(`playbackState: ${e}`);
		let a = i.activePlayer === void 0;
		(this.isActivePlayer || a) && r.dispatchEvent(x(this.#a));
	}
	get playbackState() {
		return this.#a;
	}
	get prefetched() {
		return n.getStreamInfo(this.currentStreamingSessionId)?.prefetched;
	}
	set preloadedStreamingSessionId(e) {
		this.#o = e;
	}
	get preloadedStreamingSessionId() {
		return this.#o;
	}
	reset(e) {
		return Promise.resolve();
	}
	seek(e) {}
	seekEnd(e) {
		let t = this.currentStreamingSessionId;
		if (t) {
			let n = () => p(t, {
				actionType: "PLAYBACK_START",
				assetPosition: e,
				timestamp: o.now()
			});
			if (this.playbackState === "PLAYING") n().catch(console.error);
			else {
				let e = () => {
					this.playbackState === "PLAYING" && (n().catch(console.error), r.removeEventListener("playback-state-change", e));
				};
				r.addEventListener("playback-state-change", e);
			}
		}
	}
	seekStart(e) {
		this.currentStreamingSessionId && p(this.currentStreamingSessionId, {
			actionType: "PLAYBACK_STOP",
			assetPosition: e,
			timestamp: o.now()
		}).catch(console.error);
	}
	async setStateToXIfNotYInZMs(e, n, r) {
		await t(e), this.playbackState !== n && (this.playbackState = r);
	}
	skipToPreloadedMediaProduct() {
		return Promise.resolve();
	}
	get startAssetPosition() {
		return this.#s;
	}
	set startAssetPosition(e) {
		this.#s = e;
	}
	unloadPreloadedMediaProduct() {
		return Promise.resolve();
	}
	updateOutputDevice() {
		return Promise.resolve();
	}
	updateVolumeLevel() {
		let e = n.getStreamInfo(this.currentStreamingSessionId);
		e && (this.volume = this.adjustedVolume(e));
	}
	updateVolumeLevelForNextProduct() {
		let e = n.getStreamInfo(this.preloadedStreamingSessionId);
		e && (this.volume = this.adjustedVolume(e));
	}
	get volume() {
		return 1;
	}
	set volume(e) {}
};
//#endregion
export { y as n, v as r, k as t };

