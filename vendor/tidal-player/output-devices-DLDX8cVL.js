import { i as e, n as t, r as n, t as r } from "./generate-guid-C7EoYu64.js";
import { r as i, t as a } from "./state-BujoNwcN.js";
//#region ../../node_modules/.pnpm/js-levenshtein@1.1.6/node_modules/js-levenshtein/index.js
var o = /* @__PURE__ */ n(((e, t) => {
	t.exports = (function() {
		function e(e, t, n, r, i) {
			return e < t || n < t ? e > n ? n + 1 : e + 1 : r === i ? t : t + 1;
		}
		return function(t, n) {
			if (t === n) return 0;
			if (t.length > n.length) {
				var r = t;
				t = n, n = r;
			}
			for (var i = t.length, a = n.length; i > 0 && t.charCodeAt(i - 1) === n.charCodeAt(a - 1);) i--, a--;
			for (var o = 0; o < i && t.charCodeAt(o) === n.charCodeAt(o);) o++;
			if (i -= o, a -= o, i === 0 || a < 3) return a;
			var s = 0, c, l, u, d, f, p, m, h, g, _, v, y, b = [];
			for (c = 0; c < i; c++) b.push(c + 1), b.push(t.charCodeAt(o + c));
			for (var x = b.length - 1; s < a - 3;) for (g = n.charCodeAt(o + (l = s)), _ = n.charCodeAt(o + (u = s + 1)), v = n.charCodeAt(o + (d = s + 2)), y = n.charCodeAt(o + (f = s + 3)), p = s += 4, c = 0; c < x; c += 2) m = b[c], h = b[c + 1], l = e(m, l, u, g, h), u = e(l, u, d, _, h), d = e(u, d, f, v, h), p = e(d, f, p, y, h), b[c] = p, f = d, d = u, u = l, l = m;
			for (; s < a;) for (g = n.charCodeAt(o + (l = s)), p = ++s, c = 0; c < x; c += 2) m = b[c], b[c] = p = e(m, l, p, g, b[c + 1]), l = m;
			return p;
		};
	})();
})), s = /* @__PURE__ */ e(t(), 1), c = /* @__PURE__ */ e(o(), 1);
function l(e) {
	return new CustomEvent("device-change", { detail: { devices: e } });
}
//#endregion
//#region src/internal/output-devices.ts
var u = s.default.parse(navigator.userAgent), d = class {
	controllableVolume;
	id;
	name;
	nativeDeviceId;
	type;
	webDeviceId;
	constructor({ controllableVolume: e, name: t, nativeDeviceId: n, type: i, webDeviceId: a }) {
		this.name = t, this.id = n === "default" && a === "default" ? "default" : r(), this.nativeDeviceId = n, this.webDeviceId = a, this.type = i, this.controllableVolume = e !== !1;
	}
};
function f(e) {
	if (m(e)) return "windowsCommunication";
	if ("id" in e && e.id === "BuiltInSpeakerDevice") return "builtIn";
	if ("type" in e && e.type === "airplay") return "airplay";
	if ("label" in e) {
		let t = e.label.toLowerCase();
		if (t.includes("bluetooth")) return "bluetooth";
		if (t.includes("displayport")) return "displayPort";
		if (t.includes("hdmi")) return "hdmi";
		if (t.includes("usb")) return "usb";
		if (t.includes("built-in")) return "builtIn";
		if (t.includes("airplay")) return "airplay";
	}
}
function p(e, t) {
	let n = t.toLowerCase(), r = e;
	return n.includes("mac") && (r = (e.split("(")[0] ?? "").trim()), r;
}
function m(e) {
	let t;
	return "label" in e && (t = e.label), "name" in e && (t = e.name), t?.startsWith("Communications") ?? !1;
}
function h(e, t) {
	if (t = p(t, u.os.name || ""), [...e].length === 0 || t === "") return;
	let n = [...e].find((e) => e.name === t);
	if (n) return n;
	let r = [...e].filter((e) => t.includes(e.name) || e.name.includes(t)).map((e) => ({
		device: e,
		distance: (0, c.default)(e.name, t)
	})).sort((e, t) => e.distance - t.distance).reverse();
	if (r.length > 0) {
		let e = r.pop();
		if (e && e.distance <= 16) return e.device;
	}
}
var g = new class {
	#e;
	#t;
	#n = "shared";
	#r;
	#i;
	#a;
	outputDevices;
	constructor() {
		this.#i = /* @__PURE__ */ new Set(), this.#a = /* @__PURE__ */ new Set(), this.#r = new EventTarget(), this.#t = new d({
			name: "System Default",
			nativeDeviceId: "default",
			type: "systemDefault",
			webDeviceId: "default"
		}), this.#e = this.#t, this.outputDevices = /* @__PURE__ */ new Set([this.#t]), this.hydrateWebDevices().then().catch(console.error), navigator.mediaDevices.addEventListener("devicechange", () => {
			this.hydrateWebDevices().then().catch(console.error);
		}), this.#r.addEventListener("native-devices", ((e) => {
			this.#i = new Set(e.detail), this.queueUpdate().then().catch(console.error);
		})), this.#r.addEventListener("web-devices", ((e) => {
			this.#a = new Set(e.detail), this.queueUpdate().then().catch(console.error);
		}));
	}
	set activeDevice(e) {
		this.#e = e, this.#n = "shared", a.activePlayer?.updateOutputDevice()?.catch(console.error);
	}
	get activeDevice() {
		return this.#e;
	}
	addNativeDevices(e) {
		this.#r.dispatchEvent(new CustomEvent("native-devices", { detail: e }));
	}
	addWebDevices(e) {
		e = e.filter((e) => e.deviceId !== "default"), this.#r.dispatchEvent(new CustomEvent("web-devices", { detail: e }));
	}
	set deviceMode(e) {
		let { activeDevice: t } = this, { activePlayer: n } = a;
		t && n?.name === "nativePlayer" && this.deviceMode !== e && (this.#n = e, n.updateDeviceMode());
	}
	get deviceMode() {
		return this.#n;
	}
	emitDeviceChange() {
		i.dispatchEvent(l([...this.outputDevices]));
	}
	getNativeDevice(e) {
		return [...this.#i].find((t) => t.id === e);
	}
	async hydrateWebDevices() {
		let e = (await navigator.mediaDevices.enumerateDevices()).filter((e) => e.kind === "audiooutput");
		this.addWebDevices(e);
	}
	mergeDevices() {
		[...this.outputDevices].filter((e) => e.id !== "default").forEach((e) => {
			e.nativeDeviceId = void 0, e.webDeviceId = void 0;
		}), this.#i.forEach((e) => {
			let t = h(this.outputDevices, e.name);
			t ? (t.nativeDeviceId = e.id, t.controllableVolume = e.controllableVolume, t.type = f(e) || t.type) : this.outputDevices.add(new d({
				controllableVolume: e.controllableVolume,
				name: p(e.name, u.os.name || ""),
				nativeDeviceId: e.id,
				type: f(e)
			}));
		}), this.#a.forEach((e) => {
			let t = h(this.outputDevices, e.label);
			t ? (t.webDeviceId = e.deviceId, t.type = f(e) || t.type) : this.outputDevices.add(new d({
				name: p(e.label, u.os.name || ""),
				type: f(e),
				webDeviceId: e.deviceId
			}));
		}), [...this.outputDevices].filter((e) => e.webDeviceId === void 0 && e.nativeDeviceId === void 0 || e.type === "airplay" || e.type === "windowsCommunication").forEach((e) => this.outputDevices.delete(e));
	}
	async queueUpdate() {
		let e = new Promise((e) => this.#r.addEventListener("native-devices", ((t) => e(t.detail)), { once: !0 })), t = new Promise((e) => this.#r.addEventListener("web-devices", ((t) => e(t.detail)), { once: !0 }));
		await Promise.any([
			e,
			t,
			((e) => new Promise((t) => setTimeout(() => t(), e)))(1e3)
		]), this.mergeDevices(), this.emitDeviceChange();
	}
}();
//#endregion
export { g as outputDevices };

