/**
 * Give up on a promise that is taking too long, with a sentence to show.
 *
 * One copy, because there were three of it: the socket pool's, the binding's
 * and now the link's. A wait that gives up after half a minute is exactly the
 * sort of number that drifts apart when it is written down in more than one
 * file, and the sentence it fails with is the one a person reads.
 */

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}
