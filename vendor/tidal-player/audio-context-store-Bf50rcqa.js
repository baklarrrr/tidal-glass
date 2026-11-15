//#region src/internal/helpers/wait-for-players.ts
var e = (e, t, n) => {
	for (let r of e) {
		let e = r.addedNodes[0];
		r.type === "childList" && e.id === t && n();
	}
};
function t() {
	let t = document.getElementById("tidal-player-root");
	if (!t) return Promise.reject("No player root");
	if ("video-one" in t.children) return Promise.resolve();
	let n = [];
	return "video-one" in t.children || n.push(new Promise((n) => {
		new MutationObserver((t) => e(t, "video-one", n)).observe(t, { childList: !0 });
	})), Promise.all(n);
}
//#endregion
//#region src/player/audio-context-store.ts
var n = document.createElement("video"), r = document.createElement("video"), i = (e) => {
	e.setAttribute("crossorigin", "anonymous"), e.setAttribute("playsinline", "playsinline");
};
i(n), n.id = "video-one", i(r), r.id = "video-two";
var a = "tidal-player-root";
function o() {
	let e = document.getElementById(a);
	return e && !(e instanceof HTMLDivElement) && (e.remove(), e = null), e || (e = document.createElement("div"), e.id = a, e.style.position = "absolute", e.style.width = "0", e.style.height = "0", e.style.overflow = "hidden", document.body.appendChild(e)), s();
}
function s() {
	let e = document.getElementById(a);
	return e && (e.contains(n) || e.appendChild(n), e.contains(r) || e.appendChild(r)), t();
}
function c() {
	return new Promise((e) => document.addEventListener("click", () => {
		n.readyState === HTMLMediaElement.HAVE_NOTHING && !n.src && n.load(), r.readyState === HTMLMediaElement.HAVE_NOTHING && !r.src && r.load(), e();
	}, { once: !0 }));
}
//#endregion
export { o as a, r as i, s as n, n as r, c as t };

