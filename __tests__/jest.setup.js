// Polyfill browser globals for Jest Node.js test environment.
// Obsidian plugins use window.setTimeout/setInterval/etc. for popout-window
// compatibility. In Node.js test env, window is undefined — alias it to global
// so window.setTimeout === global.setTimeout (which Node.js provides natively).
if (typeof global.window === "undefined") {
	global.window = global;
}
// activeWindow and activeDocument are Obsidian globals (declared in obsidian.d.ts).
// Point them at the global object so code that references them doesn't throw.
if (typeof global.activeWindow === "undefined") {
	global.activeWindow = global;
}
if (typeof global.activeDocument === "undefined") {
	global.activeDocument = global.document || {};
}
