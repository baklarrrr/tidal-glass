import { d as e, l as t, n, r } from "./state-BujoNwcN.js";
import { n as i, r as a } from "./audio-context-store-Bf50rcqa.js";
import { n as o, r as s, t as c } from "./basePlayer-taUs4qIw.js";
import { t as l } from "./media-element-error-circuit-breaker-BgFhgr5-.js";
//#region src/player/browserPlayer.ts
var u = class extends c {
	#e;
	#t;
	#n = !0;
	#r;
	#i = l();
	#a;
	#o = document.createElement("video");
	#s = !1;
	name = "browserPlayer";
	constructor() {
		super(), this.playbackState = "IDLE";
		let e = () => {
			this.mediaElement && !this.mediaElement.paused && (this.playbackState = "PLAYING");
		}, r = (e) => {
			this.currentStreamingSessionId && e.target instanceof HTMLMediaElement && n.overwriteDuration(this.currentStreamingSessionId, e.target.duration);
		}, o = () => {
			this.playbackState = "STALLED";
		}, s = () => {
			(async () => {
				let e = this.#e;
				if (e) {
					if (this.preloadedStreamingSessionId && e.currentTime === e.duration && (await t(1e3), e.currentTime !== e.duration)) return;
					this.playbackState = "NOT_PLAYING";
				}
			})().catch(console.error);
		}, c = (e) => {
			if (e instanceof Event) {
				let t = e.target;
				t.readyState > HTMLMediaElement.HAVE_NOTHING && (this.currentTime = t.currentTime);
			}
		}, l = (e) => {
			c(e), this.finishCurrentMediaProduct("completed");
		}, u = (e) => this.#i.handleError(e), d = () => {
			this.mediaElement && (this.currentTime = this.mediaElement.currentTime, this.seekEnd(this.currentTime));
		};
		this.#a = {
			durationChangeHandler: r,
			endedHandler: l,
			errorHandler: u,
			pauseHandler: s,
			playHandler: e,
			playingHandler: () => {
				this.mediaElement && !this.mediaElement.paused && this.mediaProductActuallyStarted(this.currentStreamingSessionId), e();
			},
			seekedHandler: d,
			stalledHandler: o,
			timeUpdateHandler: c,
			waitingHandler: o
		}, i().then().catch(console.error), this.#t = a, this.currentPlayer = this.#t;
	}
	#c(e, t) {
		this.debugLog("mediaElementEvents", t ? "adding to" : "removing from", e);
		let n = t ? "addEventListener" : "removeEventListener";
		e[n]("durationchange", this.#a.durationChangeHandler, { passive: !0 }), e[n]("play", this.#a.playHandler, { passive: !0 }), e[n]("playing", this.#a.playingHandler, { passive: !0 }), e[n]("timeupdate", this.#a.timeUpdateHandler, { passive: !0 }), e[n]("pause", this.#a.pauseHandler, { passive: !0 }), e[n]("ended", this.#a.endedHandler, { passive: !0 }), e[n]("error", this.#a.errorHandler, { passive: !0 }), e[n]("waiting", this.#a.waitingHandler, { passive: !0 }), e[n]("stalled", this.#a.stalledHandler, { passive: !0 }), e[n]("seeked", this.#a.seekedHandler, { passive: !0 });
	}
	get currentPlayer() {
		return this.#e;
	}
	set currentPlayer(e) {
		this.debugLog("set currentPlayer", e), this.#e && (this.#c(this.#e, !1), this.#e.load()), e && (this.#e = e, this.#c(e, !0));
	}
	getPosition() {
		return this.debugLog("getPosition"), this.mediaElement && (this.currentTime = this.mediaElement.ended ? 0 : this.mediaElement.currentTime), this.currentTime;
	}
	async load(e, t) {
		this.debugLog("load", e), this.currentTime = e.assetPosition, this.startAssetPosition = e.assetPosition, await i(), await this.reset(), this.#n = !1, t === "explicit" && (this.playbackState = "NOT_PLAYING");
		let { assetPosition: a, mediaProduct: c, playbackInfo: l, streamInfo: u } = e;
		this.currentStreamingSessionId = u.streamingSessionId;
		let { currentPlayer: d } = this;
		if (!d) return;
		let f = new Promise((e) => d.addEventListener("canplay", () => e(), { once: !0 }));
		d.src = u.streamUrl, d.currentTime = a, d.load();
		let p = new Promise((e) => d.addEventListener("durationchange", (t) => {
			t.target instanceof HTMLMediaElement && e(t.target.duration);
		}, { once: !0 }));
		if (await f, this.currentStreamingSessionId !== u.streamingSessionId) return;
		let m = await p, h = o({
			assetPosition: a,
			duration: m,
			playbackInfo: l,
			streamInfo: u
		});
		return n.saveMediaProductTransition(u.streamingSessionId, {
			mediaProduct: c,
			playbackContext: h
		}), this.debugLog("dispatching mediaProductTransition"), r.dispatchEvent(s(c, h)), this.#s ? (this.#s = !1, this.play()) : Promise.resolve();
	}
	get mediaElement() {
		return this.currentPlayer ?? null;
	}
	async next(e) {
		this.debugLog("next", e), this.playbackState === "IDLE" && (this.playbackState = "NOT_PLAYING");
		let { mediaProduct: t, playbackInfo: r, streamInfo: i } = e, a = this.#o;
		if (this.preloadedStreamingSessionId = i.streamingSessionId, !a) return;
		a.src = i.streamUrl, a.load();
		let s = await new Promise((e) => a.addEventListener("durationchange", (t) => {
			t.target instanceof HTMLMediaElement && e(t.target.duration);
		}, { once: !0 })), c = o({
			assetPosition: 0,
			duration: s,
			playbackInfo: r,
			streamInfo: i
		});
		n.saveMediaProductTransition(i.streamingSessionId, {
			mediaProduct: t,
			playbackContext: c
		}), this.#n = !1;
	}
	pause() {
		this.debugLog("pause"), this.mediaElement && this.mediaElement.pause();
	}
	async play() {
		if (this.debugLog("play"), await this.maybeHardReload(), this.playbackState === "IDLE") return this.debugLog("is IDLE, returning early"), this.#s = !0, Promise.resolve();
		"setSinkId" in a && await this.updateOutputDevice(), this.currentStreamingSessionId && this.mediaProductStarted(this.currentStreamingSessionId), this.setStateToXIfNotYInZMs(1e3, "PLAYING", "STALLED"), this.currentPlayer && await this.currentPlayer.play().catch(console.error);
	}
	async playbackEngineEndedHandler(e) {
		if (this.isActivePlayer) {
			let { reason: t } = e.detail;
			t === "completed" && (this.hasNextItem() ? (await this.skipToPreloadedMediaProduct(), await this.play()) : (console.warn("No item preloaded, not progressing."), this.playbackState = "NOT_PLAYING"));
		}
	}
	get ready() {
		return this.#r;
	}
	async reset({ keepPreload: e } = { keepPreload: !1 }) {
		if (this.#i.reset(), this.#n) return Promise.resolve();
		this.debugLog("reset"), this.playbackState !== "IDLE" && this.finishCurrentMediaProduct("skip"), this.playbackState = "IDLE", this.detachPlaybackEngineEndedHandler(), this.currentStreamingSessionId = void 0, e || (this.preloadedStreamingSessionId = void 0);
		let { currentPlayer: t } = this;
		return t && t.readyState !== 0 && (t.load(), await new Promise((e) => t.addEventListener("emptied", () => e(), { passive: !0 }))), this.#n = !0, Promise.resolve();
	}
	seek(e) {
		this.debugLog("seek", e);
		let { currentPlayer: t } = this, n = e;
		if (t) return this.seekStart(this.currentTime), "fastSeek" in t ? t.fastSeek(n) : t.currentTime = n, new Promise((e) => {
			t.addEventListener("seeked", () => e(t.currentTime), { once: !0 });
		});
	}
	async skipToPreloadedMediaProduct() {
		let e = n.getMediaProductTransition(this.preloadedStreamingSessionId);
		if (!e) {
			this.playbackState = "NOT_PLAYING";
			return;
		}
		if (this.debugLog("skipToPreloadedMediaProduct", this.preloadedStreamingSessionId), this.#o.src && this.currentPlayer) {
			this.currentPlayer.src = this.#o.src, this.currentStreamingSessionId = String(this.preloadedStreamingSessionId), this.preloadedStreamingSessionId = void 0;
			let { mediaProduct: t, playbackContext: n } = e;
			r.dispatchEvent(s(t, n)), this.playbackState === "IDLE" && (this.playbackState = "NOT_PLAYING");
		}
	}
	togglePlayback() {
		this.debugLog("togglePlayback"), this.mediaElement && (this.mediaElement.paused ? this.mediaElement.play().catch(console.error) : this.mediaElement.pause());
	}
	async unloadPreloadedMediaProduct() {
		this.debugLog("unloadPreloadedMediaProduct", this.preloadedStreamingSessionId), this.cleanUpStoredPreloadInfo();
		let e = this.#o;
		e && (e.src = "", e.load());
	}
	get volume() {
		return e("desiredVolumeLevel");
	}
	set volume(e) {
		this.debugLog("Setting volume to", e), this.currentPlayer && (this.currentPlayer.volume = e);
	}
};
//#endregion
export { u as default };

