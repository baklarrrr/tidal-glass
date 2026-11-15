//#region src/config.ts
var e = Object.freeze({
	apiUrl: "https://openapi.tidal.com/v2/",
	audioAdaptiveBitrateStreaming: !0,
	crossfadeInMs: 0,
	desiredVolumeLevel: 1,
	gatherEvents: !0,
	legacyApiUrl: "https://api.tidal.com/v1",
	loudnessNormalizationMode: "ALBUM",
	outputDevicesEnabled: !1,
	streamingWifiAudioQuality: "LOW"
});
function t(t) {
	return e[t];
}
function n(t) {
	return e = Object.freeze({
		...e,
		...t
	}), Object.keys(t).forEach((e) => {
		let n = e;
		r.dispatchEvent(new CustomEvent(n, { detail: t[n] }));
	}), e;
}
var r = new EventTarget();
//#endregion
//#region src/internal/helpers/wait-for.ts
function i(e) {
	return new Promise((t) => setTimeout(() => t(), e));
}
function a(e, t) {
	return new Promise((n) => {
		e.addEventListener(t, (e) => n(e), !1);
	});
}
//#endregion
//#region src/internal/index.ts
var o = class extends EventTarget {
	#e;
	set eventSender(e) {
		this.#e = e;
	}
	get eventSender() {
		return this.#e;
	}
	hasEventSender() {
		return !!this.#e;
	}
}, s = "A0001", c = (e) => {
	if (e?.errorCode !== s) throw e;
}, l = class extends EventTarget {
	#e;
	#t = 0;
	set credentialsProvider(e) {
		if (this.#e === e) return;
		this.#e = e, this.#t += 1;
		let t = this.#t;
		this.dispatchAuthorized(t).catch(console.error), this.#e.bus((e) => {
			if (t === this.#t) switch (e.detail.type) {
				case "CredentialsUpdatedMessage":
					this.dispatchAuthorized(t).catch(console.error);
					break;
				default: console.warn("Unhandled event from credentials provider: ", e);
			}
		});
	}
	get credentialsProvider() {
		return this.#e;
	}
	async dispatchAuthorized(e) {
		let t = await this.#e.getCredentials().catch(c);
		(e === void 0 || e === this.#t) && (t?.token ? this.dispatchEvent(new CustomEvent("authorized", { detail: { credentials: t } })) : this.dispatchEvent(new CustomEvent("unauthenticated", { detail: { credentials: t } })));
	}
}, u = class extends Error {
	errorCode = null;
	errorId = null;
	referenceId;
	constructor(e, t, n) {
		super(`${e}: ${t} (${n})`), this.errorId = e, this.errorCode = t, this.referenceId = n;
	}
	toJSON() {
		return {
			errorCode: this.errorCode,
			errorId: this.errorId,
			referenceId: this.referenceId
		};
	}
	toString() {
		return JSON.stringify(this.toJSON());
	}
};
async function d() {
	if (f.credentialsProvider) {
		let e = await f.credentialsProvider.getCredentials().catch(c);
		return !!(e?.token && e.userId);
	}
	return await a(f, "authorized"), d();
}
var f = new l(), p = new o();
async function m() {
	let e = await d(), t = async () => {
		let { Pushkin: e } = await import("./pushkin-DrXZTQWP.js");
		return e.refresh();
	};
	if (e) {
		n({ gatherEvents: !0 });
		try {
			await Promise.all([t()]);
		} catch (e) {
			console.error(e);
		}
	} else n({ gatherEvents: !1 });
}
function h() {
	n({ gatherEvents: !0 });
}
f.addEventListener("authorized", () => {
	m().then().catch(console.error);
}), f.addEventListener("unauthenticated", () => {
	h();
});
async function g() {
	return f.credentialsProvider ? (await f.credentialsProvider.getCredentials()).token ?? null : null;
}
var _ = new class extends EventTarget {
	dispatchError(e) {
		this.dispatchEvent(new CustomEvent("error", { detail: e.toJSON() }));
	}
}(), v = new class {
	#e = /* @__PURE__ */ new Map();
	#t = /* @__PURE__ */ new Map();
	#n = /* @__PURE__ */ new Set();
	#r = /* @__PURE__ */ new Map();
	#i = /* @__PURE__ */ new Map();
	clone(e, t) {
		let n = this.getMediaProductTransition(e), r = this.getStreamInfo(e), i = this.getPlaybackInfo(e);
		if (!n || !r || !i) throw Error(`Cannot clone ${e}. Missing mediaProductTransition or streamInfo.`);
		this.saveMediaProductTransition(t, {
			...n,
			playbackContext: {
				...n.playbackContext,
				playbackSessionId: t
			}
		}), this.saveStreamInfo(t, {
			...r,
			streamingSessionId: t
		}), this.savePlaybackInfo(t, {
			...i,
			streamingSessionId: t
		});
	}
	deleteMediaProductTransition(e) {
		this.#e.delete(e);
	}
	deleteSession(e) {
		this.deleteMediaProductTransition(e), this.#t.delete(e), this.#n.delete(e), this.#r.delete(e), this.deleteStreamInfo(e);
	}
	deleteStartedStreamInfo(e) {
		this.#r.delete(e);
	}
	deleteStreamInfo(e) {
		this.#i.delete(e);
	}
	getMediaProductTransition(e) {
		return e ? this.#e.get(e) : void 0;
	}
	getPlaybackInfo(e) {
		return e ? this.#t.get(e) : void 0;
	}
	getStreamInfo(e) {
		return e ? this.#i.get(e) : void 0;
	}
	hasMediaProductTransition(e) {
		return this.#e.has(e);
	}
	hasPlaybackInfo(e) {
		return this.#t.has(e);
	}
	hasReportedActualStart(e) {
		return this.#n.has(e);
	}
	hasStartedStreamInfo(e) {
		return this.#r.has(e);
	}
	hasStreamInfo(e) {
		return this.#i.has(e);
	}
	overwriteDuration(e, t) {
		let n = this.#e.get(e);
		n && (n.playbackContext = {
			...n.playbackContext,
			actualDuration: t
		}, this.saveMediaProductTransition(e, n));
	}
	saveMediaProductTransition(e, t) {
		this.#e.set(e, t);
	}
	savePlaybackInfo(e, t) {
		this.#t.set(e, t);
	}
	saveStreamInfo(e, t) {
		this.#i.set(e, t);
	}
	setReportedActualStart(e) {
		this.#n.add(e);
	}
	setStartedStreamInfo(e) {
		return this.#r.set(e, !0);
	}
}(), y = new class {
	activePlayer;
	preloadPlayer;
	get preloadedMediaProduct() {
		return v.getMediaProductTransition(this.preloadedStreamingSessionId)?.mediaProduct ?? void 0;
	}
	get preloadedStreamingSessionId() {
		return this.preloadPlayer?.preloadedStreamingSessionId ?? void 0;
	}
}();
//#endregion
export { f as a, d as c, t as d, n as f, u as i, i as l, v as n, p as o, _ as r, g as s, y as t, r as u };

