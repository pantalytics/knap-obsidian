// Function to perform loose comparison of objects
export function areObjectsEqual(obj1: unknown, obj2: unknown): boolean {
	if (!obj1 || !obj2) return false;

	if (typeof obj1 !== "object" || typeof obj2 !== "object") return false;

	const record1 = obj1 as Record<string, unknown>;
	const record2 = obj2 as Record<string, unknown>;

	// Check if all keys and values in obj1 match obj2
	for (const key in record1) {
		if (typeof record1[key] === "object" && record1[key] !== null) {
			if (!areObjectsEqual(record1[key], record2[key])) return false;
		} else if (record1[key] !== record2[key]) {
			return false;
		}
	}

	// Check if all keys in obj2 exist in obj1
	for (const key in record2) {
		if (!(key in record1)) return false;
	}

	return true;
}
