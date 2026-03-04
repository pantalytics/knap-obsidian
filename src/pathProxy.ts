export function createPathProxy<T extends object>(
	target: T,
	rootPath: string,
	pathConverter: (globalPath: string, rootPath: string) => string = (p, r) =>
		p.substring(r.length).replace(/^\/+/, ""),
): T {
	return new Proxy(target, {
		get(target, prop) {
			const originalMethod = (target as Record<string | symbol, unknown>)[prop];
			if (typeof originalMethod === "function") {
				return function (...args: unknown[]) {
					if (args.length > 0 && typeof args[0] === "string") {
						args[0] = pathConverter(args[0], rootPath);
					}
					return (originalMethod as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			return originalMethod;
		},
	});
}
