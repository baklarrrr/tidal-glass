import { c as e, d as t, r as n, s as r, t as i } from "./state-BujoNwcN.js";
var a = new class {
	#e;
	#t = !1;
	#n;
	#r;
	constructor(e) {
		this.#r = new URL(e), this.synchronize();
	}
	now(e = Date.now()) {
		return !this.#n || !this.#e ? (console.warn("TrueTime is not yet synchronized"), e) : this.#n + (e - this.#e);
	}
	async synchronize() {
		if (!(this.#e && Math.abs(Date.now() - this.#e) < 36e5 || this.#t)) {
			this.#t = !0;
			try {
				let e = await fetch(this.#r);
				e.ok && e.headers.has("date") && (this.#n = new Date(e.headers.get("date")).getTime(), this.#e = Date.now());
			} catch (e) {
				console.error(e);
			}
			this.#t = !1;
		}
	}
	timestamp(e, t) {
		let n;
		if (t) {
			if (n = performance.getEntriesByName(e).find((e) => "detail" in e && e.detail === t), !n) throw ReferenceError(`There is no performance entry named "${e}" with detail "${t}"`);
		} else n = performance.getEntriesByName(e).pop();
		return n ? n.startTime : void 0;
	}
}("https://api.tidal.com/v1/ping"), o = "streaming-privileges-revoked";
function s(e) {
	return new CustomEvent(o, { detail: e });
}
//#endregion
//#region src/internal/services/pushkin.ts
var c;
async function l(e) {
	let n = t("legacyApiUrl"), { url: r } = await (await fetch(n + "/rt/connect", {
		headers: new Headers({
			Authorization: "Bearer " + e,
			"Content-Type": "application/json"
		}),
		method: "POST"
	})).json();
	return r;
}
function u(e) {
	return new Promise((t) => {
		e.addEventListener("open", () => t(), { once: !0 });
	});
}
var d = class t {
	#e;
	#t;
	#n;
	#r;
	constructor() {
		this.#r = void 0, this.#t = this.#i(), n.addEventListener("user-action", () => {
			this.connected && this.userAction().then().catch(console.error);
		});
	}
	static async ensure() {
		await e() && (c ? c.connected || await c.reconnect() : c = new t());
	}
	static async refresh() {
		if (!await e()) return;
		let t = await r();
		c && t && c.reconnect().catch(console.error);
	}
	async #i() {
		let e = await r();
		if (!e) throw Error("No access token to connect to Pushkin.");
		let t = await l(e);
		t && (this.#r = new WebSocket(t), await u(this.#r), this.#n = ((e) => this.#s(e.data)), this.#e = () => this.#o(), this.#r.addEventListener("message", this.#n, !1), this.#r.addEventListener("closed", this.#e, !1), window.addEventListener("online", () => this.#o(), { once: !0 }));
	}
	async #a(e) {
		if (!this.#r) throw Error("No socket connected. Did you forget to call connect method in Pushkin service first?");
		this.#r.readyState !== WebSocket.OPEN && await this.#t, this.#r.send(JSON.stringify(e));
	}
	#o() {
		this.#t = this.#i();
	}
	#s(e) {
		let t = JSON.parse(e);
		switch (t.type) {
			case "PRIVILEGED_SESSION_NOTIFICATION":
				n.dispatchEvent(s(String(t.payload.clientDisplayName))), i.activePlayer?.pause();
				break;
			case "RECONNECT":
				this.reconnect().catch(console.error);
				break;
			default: console.warn("Unhandled event from Pushkin: ", t);
		}
	}
	get connected() {
		return this.#r && this.#r.readyState === WebSocket.OPEN;
	}
	reconnect() {
		return this.#r ? (this.#n && this.#r.removeEventListener("message", this.#n), this.#e && this.#r.removeEventListener("closed", this.#e), this.#r.close(), this.#t = this.#i(), this.#t) : Promise.resolve();
	}
	async userAction() {
		this.connected || await this.reconnect();
		try {
			await this.#a({
				payload: { startedAt: a.now() },
				type: "USER_ACTION"
			});
		} catch (e) {
			console.error(e);
		}
	}
};
//#endregion
export { a as i, l as n, u as r, d as t };

