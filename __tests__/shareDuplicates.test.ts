import { findShareForPath, normalizeSharePath } from "../src/shareDuplicates";

describe("normalizeSharePath", () => {
	it("leaves an ordinary vault path alone", () => {
		expect(normalizeSharePath("01 Projects")).toBe("01 Projects");
		expect(normalizeSharePath("01 Projects/Knap")).toBe("01 Projects/Knap");
	});

	it("drops surrounding whitespace", () => {
		expect(normalizeSharePath("  01 Projects  ")).toBe("01 Projects");
	});

	it("drops leading and trailing slashes", () => {
		expect(normalizeSharePath("/01 Projects/")).toBe("01 Projects");
	});

	it("collapses repeated separators", () => {
		expect(normalizeSharePath("01 Projects//Knap")).toBe("01 Projects/Knap");
	});

	it("keeps case, because a vault does", () => {
		expect(normalizeSharePath("Projects")).not.toBe(normalizeSharePath("projects"));
	});
});

describe("findShareForPath", () => {
	const shares = [
		{ id: "a", path: "01 Projects" },
		{ id: "b", path: "02 Areas/Home" },
	];

	it("finds the share on the same path", () => {
		expect(findShareForPath(shares, "01 Projects")?.id).toBe("a");
		expect(findShareForPath(shares, "02 Areas/Home")?.id).toBe("b");
	});

	it("finds it through the differences normalization removes", () => {
		expect(findShareForPath(shares, " 01 Projects ")?.id).toBe("a");
		expect(findShareForPath(shares, "/01 Projects")?.id).toBe("a");
		expect(findShareForPath(shares, "02 Areas//Home")?.id).toBe("b");
	});

	it("matches a stored path that needs normalizing too", () => {
		expect(findShareForPath([{ id: "c", path: "/01 Projects/" }], "01 Projects")?.id).toBe("c");
	});

	it("does not match a different folder", () => {
		expect(findShareForPath(shares, "03 Resources")).toBeUndefined();
		expect(findShareForPath(shares, "01 Projects/Knap")).toBeUndefined();
	});

	it("does not fold case, so two real folders stay apart", () => {
		expect(findShareForPath(shares, "01 projects")).toBeUndefined();
	});

	it("matches nothing on an empty path", () => {
		expect(findShareForPath(shares, "")).toBeUndefined();
		expect(findShareForPath(shares, "   ")).toBeUndefined();
		expect(findShareForPath(shares, "/")).toBeUndefined();
	});

	it("matches nothing when there are no shares", () => {
		expect(findShareForPath([], "01 Projects")).toBeUndefined();
	});
});
