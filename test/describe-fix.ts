import { test, describe as describe0 } from "bun:test";

export function describe(label: string, fn: () => void) {
	describe0(label, async () => {
		try {
			await fn();
		} catch (cause) {
			test("init()", () => {
				throw cause;
			});
		}
	});
}
