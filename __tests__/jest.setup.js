// Polyfill browser globals for Jest Node.js test environment.
// Obsidian plugins use window.setTimeout/setInterval/etc. for popout-window
// compatibility. In Node.js test env, window is undefined — alias it to global
// so window.setTimeout === global.setTimeout (which Node.js provides natively).
if (typeof global.window === "undefined") {
	global.window = global;
}
// Node's plain global object is not an EventTarget — unlike a real
// window/activeWindow, it has no addEventListener/removeEventListener. Code
// that calls window.addEventListener/activeWindow.addEventListener (e.g. an
// "unload" cleanup listener) throws in this test env otherwise. No-op stubs
// are enough here: nothing in this test suite depends on these listeners
// actually firing, only on constructing/tearing down without throwing.
if (typeof global.addEventListener !== "function") {
	global.addEventListener = () => {};
}
if (typeof global.removeEventListener !== "function") {
	global.removeEventListener = () => {};
}
// activeWindow and activeDocument are Obsidian globals (declared in obsidian.d.ts).
// Point them at the global object so code that references them doesn't throw.
if (typeof global.activeWindow === "undefined") {
	global.activeWindow = global;
}
if (typeof global.activeDocument === "undefined") {
	global.activeDocument = global.document || {};
}
