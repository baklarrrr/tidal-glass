import { d as e, i as t, n, r, t as i } from "./state-BujoNwcN.js";
import { i as a } from "./pushkin-C5TU0Pwc.js";
import { l as o, m as s } from "./load-uTL4eiru.js";
import { t as c } from "./active-device-mode-changed-OmLVES_4.js";
import { t as l } from "./active-device-changed-BDbOSq7P.js";
import { n as u, r as d, t as f } from "./basePlayer-taUs4qIw.js";
//#region src/api/event/active-device-disconnected.ts
var p = "active-device-disconnected";
function m() {
	return new CustomEvent(p);
}
//#endregion
//#region src/player/nativePlayer.ts
var h = {
	file_checksum_mismatch: "NPO02",
	no_such_file: "NPO01",
	unreadable_file: "NPO03"
}, g = {
	devicedisconnected: "NPD01",
	deviceexclusivemodenotallowed: "NPD02",
	deviceformatnotsupported: "NPD03",
	devicelocked: "NPD04",
	devicenotfound: "NPD05",
	deviceunknownerror: "NPD00"
}, _, v = class extends f {
	#e = "default";
	#t;
	#n;
	#r;
	name = "nativePlayer";
	playbackEngineHandlerAttached = !1;
	constructor() {
		super(), e("outputDevicesEnabled") && (async () => {
			_ = (await import("./output-devices-DLDX8cVL.js")).outputDevices, this.#n.listDevices();
		})(), this.#n = window.NativePlayerComponent.Player(), this.playbackState = "IDLE", this.registerEventListeners(), this.#n.setVolume(100);
	}
	#i(e) {
		r.dispatchError(new t("EUnexpected", g[e]));
	}
	#a(e) {
		this.debugLog("handleMediaError", e.target);
		let n = h[e.target.errorCode];
		this.currentStreamingSessionId && s({
			errorCode: n,
			errorMessage: JSON.stringify(e.target),
			streamingSessionId: this.currentStreamingSessionId
		}), r.dispatchError(new t("EUnexpected", n));
	}
	#o(e) {
		switch (this.debugLog("handleNativePlayerStateChange", e), e) {
			case "active":
				this.mediaProductActuallyStarted(this.currentStreamingSessionId), this.playbackState = "PLAYING";
				break;
			case "idle":
			case "seeking":
				this.playbackState = "STALLED";
				break;
			case "paused":
			case "ready":
				this.playbackState = "NOT_PLAYING";
				break;
			case "stopped":
				this.playbackState = "NOT_PLAYING";
				break;
			case "uninitialized":
				this.playbackState = "IDLE";
				break;
			default: this.debugLog("No handling for state", e);
		}
	}
	async #s() {
		this.debugLog("handleNetworkError");
		let e = o.get("streaming_metrics:playback_statistics:actualStartTimestamp", this.currentStreamingSessionId);
		if ((e === void 0 ? 0 : Math.abs(a.now() - e)) >= 36e5) {
			let e = structuredClone(this.currentMediaProduct), t = this.currentTime;
			this.finishCurrentMediaProduct("error"), e && (await this.hardReload(e, t), await this.play());
			return;
		}
		await Promise.race([this.mediaStateChange("idle"), new Promise((e) => {
			window.addEventListener("online", () => e("online"));
		})]) === "idle" && r.dispatchError(new t("PENetwork", "NPN01"));
	}
	abandon() {
		_?.deviceMode === "exclusive" && this.#n.selectSystemDevice();
	}
	getPosition() {
		return this.currentTime;
	}
	async handleAutomaticTransitionToPreloadedMediaProduct() {
		let e = this.preloadedStreamingSessionId, t = await this.nativeEvent("mediaduration");
		this.#t = Number(t.target), this.#r = void 0;
		let i = n.getMediaProductTransition(e);
		if (!i) {
			console.warn("No media product transition saved for next item. Stopping playback."), this.playbackState = "NOT_PLAYING";
			return;
		}
		let { mediaProduct: a, playbackContext: o } = i, s = {
			...o,
			actualDuration: this.#t
		};
		e && n.saveMediaProductTransition(e, {
			mediaProduct: a,
			playbackContext: s
		}), await this.mediaStateChange("active"), this.mediaProductActuallyStarted(e), r.dispatchEvent(d(a, s)), this.currentStreamingSessionId = e, this.mediaProductStarted(this.currentStreamingSessionId);
	}
	async load(e, t) {
		this.debugLog("load", e), this.currentTime = e.assetPosition, this.startAssetPosition = e.assetPosition, await this.reset();
		let { assetPosition: i, mediaProduct: a, playbackInfo: o, streamInfo: s } = e, { securityToken: c, streamFormat: l, streamUrl: f } = s;
		this.currentStreamingSessionId = s.streamingSessionId, t === "explicit" && (this.playbackState = "NOT_PLAYING");
		let p = this.nativeEvent("mediaduration");
		if (l) this.#n.load(f, l, c);
		else throw Error("Stream format is undefined.");
		let m = await p;
		if (this.#t = Number(m.target), this.currentStreamingSessionId !== s.streamingSessionId) return;
		this.debugLog("load() duration is", this.#t), i !== 0 && i < this.#t ? (async () => {
			await this.mediaStateChange("active"), this.currentStreamingSessionId === s.streamingSessionId && (await this.seek(i), this.currentTime = i);
		})().catch(console.error) : this.currentTime = 0;
		let h = u({
			assetPosition: i,
			duration: this.#t,
			playbackInfo: o,
			streamInfo: s
		});
		n.saveMediaProductTransition(s.streamingSessionId, {
			mediaProduct: a,
			playbackContext: h
		}), this.debugLog("load() mediaProductTransition"), r.dispatchEvent(d(a, h)), this.debugLog("load() pb NOT_PLAYING"), this.debugLog("load() done");
	}
	mediaStateChange(e) {
		return new Promise((t) => {
			let n = (r) => {
				r.target === e && (this.#n.removeEventListener("mediastate", n), t(r.target));
			};
			this.#n.addEventListener("mediastate", n);
		});
	}
	nativeEvent(e) {
		return new Promise((t) => {
			let n = (r) => {
				this.#n.removeEventListener(e, n), t(r);
			};
			this.#n.addEventListener(e, n);
		});
	}
	async next(e) {
		this.debugLog("next", e), this.hasNextItem() && await this.unloadPreloadedMediaProduct();
		let { mediaProduct: t, playbackInfo: r, streamInfo: i } = e, { securityToken: a, streamFormat: o, streamUrl: s, streamingSessionId: c } = i;
		this.preloadedStreamingSessionId = c, this.debugLog("preloading", s, "for", c), o ? (this.#n.preload(s, o, a), this.isActivePlayer || this.#n.pause()) : console.error("Stream format undefined for preload."), this.debugLog("preloading done");
		let l = u({
			assetPosition: 0,
			duration: 0,
			playbackInfo: r,
			streamInfo: i
		});
		n.saveMediaProductTransition(c, {
			mediaProduct: t,
			playbackContext: l
		}), this.#r = e;
	}
	pause() {
		this.#n.pause();
	}
	async play() {
		if (this.debugLog("play"), await this.maybeHardReload(), this.playbackState === "IDLE") {
			this.debugLog("play()", this.playbackState, "returning early");
			return;
		}
		this.setStateToXIfNotYInZMs(1e3, "PLAYING", "STALLED"), await this.updateOutputDevice(), this.mediaProductStarted(this.currentStreamingSessionId), this.debugLog("nativePlayer", "play()"), this.#n.play();
	}
	async playbackEngineEndedHandler(e) {
		if (this.isActivePlayer) {
			let { reason: t } = e.detail;
			t === "completed" && (this.hasNextItem() ? await this.handleAutomaticTransitionToPreloadedMediaProduct() : (i.preloadedStreamingSessionId ? this.debugLog(`Switching player from ${this.name} to ${i.preloadPlayer?.name}`) : this.debugLog("No next item queued."), this.playbackState = "NOT_PLAYING"));
		}
	}
	get ready() {
		return Promise.resolve();
	}
	registerEventListeners() {
		this.debugLog("registerEventListeners"), this.#n.addEventListener("mediacurrenttime", (e) => {
			this.currentTime = Number(e.target);
		}), this.#n.addEventListener("mediastate", (e) => {
			if (e.target === "completed") {
				let e = !!this.hasNextItem();
				e && o.mark("streaming_metrics:playback_statistics:idealStartTimestamp", i.preloadedStreamingSessionId), this.finishCurrentMediaProduct("completed", e), e && (this.updateVolumeLevelForNextProduct(), this.isActivePlayer && this.handleAutomaticTransitionToPreloadedMediaProduct().catch(console.error));
			} else this.#o(e.target);
		}), this.#n.addEventListener("devices", (e) => {
			_ ? _.addNativeDevices(e.target) : console.error("Output devices not loaded.");
		}), this.#n.addEventListener("devicedisconnected", () => {
			r.dispatchEvent(m()), this.#i("devicedisconnected");
		}), this.#n.addEventListener("deviceexclusivemodenotallowed", () => this.#i("deviceexclusivemodenotallowed")), this.#n.addEventListener("deviceformatnotsupported", () => this.#i("deviceformatnotsupported")), this.#n.addEventListener("devicelocked", () => this.#i("devicelocked")), this.#n.addEventListener("devicenotfound", () => this.#i("devicenotfound")), this.#n.addEventListener("deviceunknownerror", () => this.#i("deviceunknownerror")), this.#n.addEventListener("mediaduration", (e) => {
			this.#t = Number(e.target);
		}), this.#n.addEventListener("mediaerror", (e) => this.#a(e)), this.#n.addEventListener("mediamaxconnectionsreached", () => {
			this.#s().catch(console.error);
		});
	}
	async reset({ keepPreload: e } = { keepPreload: !1 }) {
		this.currentStreamingSessionId !== void 0 && (this.debugLog("reset"), e || await this.unloadPreloadedMediaProduct(), this.#n.stop(), this.playbackState !== "IDLE" && this.finishCurrentMediaProduct("skip"), this.detachPlaybackEngineEndedHandler(), this.currentStreamingSessionId = void 0, e || (this.preloadedStreamingSessionId = void 0), this.playbackState = "IDLE");
	}
	async seek(e) {
		this.hasStarted() || await this.mediaStateChange("active"), this.seekStart(this.currentTime), this.currentTime = e, this.#n.seek(e), this.seekEnd(this.currentTime);
	}
	async skipToPreloadedMediaProduct() {
		this.debugLog("skipToPreloadedMediaProduct", this.preloadedStreamingSessionId);
		let e = this.currentStreamingSessionId === void 0;
		if (this.preloadedStreamingSessionId && this.#r) {
			let t = n.getMediaProductTransition(this.preloadedStreamingSessionId);
			t && (this.#r.mediaProduct = t.mediaProduct), await this.load(this.#r, "implicit"), await this.updateOutputDevice(), e && (this.playbackState = "PLAYING"), this.playbackState === "IDLE" && (this.playbackState = "NOT_PLAYING");
			return;
		}
		console.warn("No preloaded item in native player.");
	}
	async unloadPreloadedMediaProduct() {
		this.debugLog("unloadPreloadedMediaProduct", this.preloadedStreamingSessionId), this.hasNextItem() && (this.cleanUpStoredPreloadInfo(), "cancelPreload" in this.#n ? this.#n.cancelPreload() : console.warn("cancelPreload not available. Update native player."));
	}
	updateDeviceMode() {
		this.updateOutputDevice()?.catch(console.error), _ && r.dispatchEvent(c(_.deviceMode));
	}
	updateOutputDevice() {
		if (!_ || (this.debugLog("updateOutputDevice", _.activeDevice), !_.activeDevice)) return Promise.resolve();
		let { nativeDeviceId: e } = _.activeDevice;
		if (this.outputDeviceType = _.activeDevice.type, e === "default") this.#e !== "default" && (this.#n.selectSystemDevice(), r.dispatchEvent(l("default")), this.#e = "default");
		else if (e) {
			let t = _.getNativeDevice(e);
			t && (this.#n.selectDevice(t, _.deviceMode), r.dispatchEvent(l(_.activeDevice.id)), r.dispatchEvent(c(_.deviceMode)), this.#e = e);
		} else throw Error(`Device with sinkId ${e} not found.`);
		return Promise.resolve();
	}
	get volume() {
		return e("desiredVolumeLevel");
	}
	set volume(e) {
		this.debugLog("Setting volume to", e), this.#n.setVolume(e * 100);
	}
};
//#endregion
export { v as default };

