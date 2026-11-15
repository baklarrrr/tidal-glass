import { i as e, r as t } from "./state-BujoNwcN.js";
import { i as n } from "./pushkin-C5TU0Pwc.js";
var r = 6e4, i = (e) => {
	console.error("HTMLMediaElement errored", e.target?.error ?? null);
}, a = () => {
	console.error("HTMLMediaElement error limit reached, suppressing further errors"), t.dispatchError(new e("EUnexpected", "ME01"));
};
function o(e = {}) {
	let { errorWindowMs: t = r, log: o = i, maxErrors: s = 10, now: c = () => n.now(), onLimitReached: l = a } = e, u = 0, d = 0;
	return {
		handleError(e) {
			let n = c();
			n - d >= t && (u = 0), d = n, u += 1, u <= s && o(e), u === s && l();
		},
		reset() {
			u = 0, d = 0;
		}
	};
}
//#endregion
export { o as t };

