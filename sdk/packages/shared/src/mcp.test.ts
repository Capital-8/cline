import { describe, expect, it } from "vitest";
import {
	clampMcpTimeoutSeconds,
	collectMcpPages,
	DEFAULT_MCP_TIMEOUT_SECONDS,
	formatMcpTimeoutErrorMessage,
	isMcpTimeoutConfigured,
	MAX_MCP_LIST_PAGES,
	MAX_MCP_TIMEOUT_SECONDS,
	type McpListPage,
	MIN_MCP_TIMEOUT_SECONDS,
	resolveMcpTimeoutSeconds,
} from "./mcp";

describe("collectMcpPages", () => {
	function pagedFetcher(pages: readonly McpListPage<string>[]) {
		const cursors: Array<string | undefined> = [];
		const byCursor = new Map<string | undefined, McpListPage<string>>();
		let key: string | undefined;
		for (const page of pages) {
			byCursor.set(key, page);
			key = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
		}
		return {
			cursors,
			fetchPage: async (cursor: string | undefined) => {
				cursors.push(cursor);
				const page = byCursor.get(cursor);
				if (!page) {
					throw new Error(`unknown cursor ${String(cursor)}`);
				}
				return page;
			},
		};
	}

	it("returns a single page without sending a cursor", async () => {
		const { cursors, fetchPage } = pagedFetcher([{ items: ["a", "b"] }]);
		await expect(
			collectMcpPages({ serverName: "s", method: "tools/list", fetchPage }),
		).resolves.toEqual(["a", "b"]);
		expect(cursors).toEqual([undefined]);
	});

	it("follows opaque cursors in order, including through empty pages", async () => {
		const { cursors, fetchPage } = pagedFetcher([
			{ items: ["a"], nextCursor: "opaque:/page+2?token=a%3Db" },
			{ items: [], nextCursor: "opaque:/page+3?token=c%3Dd" },
			{ items: ["b", "c"] },
		]);
		await expect(
			collectMcpPages({ serverName: "s", method: "tools/list", fetchPage }),
		).resolves.toEqual(["a", "b", "c"]);
		expect(cursors).toEqual([
			undefined,
			"opaque:/page+2?token=a%3Db",
			"opaque:/page+3?token=c%3Dd",
		]);
	});

	it("treats null, non-string and empty cursors as the end of the list", async () => {
		for (const nextCursor of [null, 0, "", {}, false]) {
			const { cursors, fetchPage } = pagedFetcher([
				{ items: ["a"], nextCursor },
			]);
			await expect(
				collectMcpPages({ serverName: "s", method: "tools/list", fetchPage }),
			).resolves.toEqual(["a"]);
			expect(cursors).toEqual([undefined]);
		}
	});

	it("rejects a cursor that does not advance", async () => {
		const cursors: Array<string | undefined> = [];
		const fetchPage = async (cursor: string | undefined) => {
			cursors.push(cursor);
			// Every page, including the one reached via c1, points at c1 again.
			return { items: ["a"], nextCursor: "c1" };
		};
		await expect(
			collectMcpPages({ serverName: "s", method: "tools/list", fetchPage }),
		).rejects.toThrow(
			'MCP server "s" returned a repeated tools/list cursor; stopping pagination.',
		);
		// The first cursor was followed once; the repeat was caught before a
		// third request went out.
		expect(cursors).toEqual([undefined, "c1"]);
	});

	it("rejects a multi-page cursor cycle rather than looping", async () => {
		const requests: Array<string | undefined> = [];
		const fetchPage = async (cursor: string | undefined) => {
			requests.push(cursor);
			// A -> B -> A -> B ...
			return { items: ["x"], nextCursor: cursor === "A" ? "B" : "A" };
		};
		await expect(
			collectMcpPages({ serverName: "s", method: "prompts/list", fetchPage }),
		).rejects.toThrow("repeated prompts/list cursor");
		expect(requests).toEqual([undefined, "A", "B"]);
	});

	it("stops after the page cap when a server never ends", async () => {
		let n = 0;
		const fetchPage = async () => ({ items: [n], nextCursor: `c${n++}` });
		await expect(
			collectMcpPages({
				serverName: "s",
				method: "resources/list",
				fetchPage,
				maxPages: 3,
			}),
		).rejects.toThrow(
			'MCP server "s" returned more than 3 resources/list pages; stopping pagination.',
		);
		expect(n).toBe(3);
		expect(MAX_MCP_LIST_PAGES).toBeGreaterThan(3);
	});

	it("propagates a later-page error instead of returning a partial list", async () => {
		const fetchPage = async (cursor: string | undefined) => {
			if (cursor === undefined) {
				return { items: ["a"], nextCursor: "c1" };
			}
			throw new Error("later page failed");
		};
		await expect(
			collectMcpPages({ serverName: "s", method: "tools/list", fetchPage }),
		).rejects.toThrow("later page failed");
	});
});

describe("resolveMcpTimeoutSeconds", () => {
	it("returns the default for missing or non-numeric values", () => {
		expect(resolveMcpTimeoutSeconds(undefined)).toBe(
			DEFAULT_MCP_TIMEOUT_SECONDS,
		);
		expect(resolveMcpTimeoutSeconds(null)).toBe(DEFAULT_MCP_TIMEOUT_SECONDS);
		expect(resolveMcpTimeoutSeconds("120")).toBe(DEFAULT_MCP_TIMEOUT_SECONDS);
		expect(resolveMcpTimeoutSeconds(Number.NaN)).toBe(
			DEFAULT_MCP_TIMEOUT_SECONDS,
		);
		expect(resolveMcpTimeoutSeconds(Infinity)).toBe(
			DEFAULT_MCP_TIMEOUT_SECONDS,
		);
	});

	it("passes through valid values unchanged", () => {
		expect(resolveMcpTimeoutSeconds(60)).toBe(60);
		expect(resolveMcpTimeoutSeconds(1)).toBe(1);
		expect(resolveMcpTimeoutSeconds(3600)).toBe(3600);
	});

	it("clamps values outside the bounds", () => {
		expect(resolveMcpTimeoutSeconds(0)).toBe(MIN_MCP_TIMEOUT_SECONDS);
		expect(resolveMcpTimeoutSeconds(-5)).toBe(MIN_MCP_TIMEOUT_SECONDS);
		// A milliseconds/seconds mix-up (60000 meaning 60s) clamps instead of
		// becoming ~16 hours.
		expect(resolveMcpTimeoutSeconds(60000)).toBe(MAX_MCP_TIMEOUT_SECONDS);
	});
});

describe("isMcpTimeoutConfigured", () => {
	it("accepts only finite numeric values", () => {
		expect(isMcpTimeoutConfigured(60)).toBe(true);
		expect(isMcpTimeoutConfigured(undefined)).toBe(false);
		expect(isMcpTimeoutConfigured(null)).toBe(false);
		expect(isMcpTimeoutConfigured("60")).toBe(false);
		expect(isMcpTimeoutConfigured(Number.NaN)).toBe(false);
		expect(isMcpTimeoutConfigured(Infinity)).toBe(false);
	});
});

describe("clampMcpTimeoutSeconds", () => {
	it("clamps into [MIN, MAX]", () => {
		expect(clampMcpTimeoutSeconds(0)).toBe(MIN_MCP_TIMEOUT_SECONDS);
		expect(clampMcpTimeoutSeconds(120)).toBe(120);
		expect(clampMcpTimeoutSeconds(999999)).toBe(MAX_MCP_TIMEOUT_SECONDS);
	});
});

describe("formatMcpTimeoutErrorMessage", () => {
	it("names the server, effective bound, and setting to change", () => {
		expect(formatMcpTimeoutErrorMessage("slow-server", 120_000)).toBe(
			'MCP request to "slow-server" timed out after 120s. Increase the "timeout" field (in seconds) for this server in cline_mcp_settings.json.',
		);
	});

	it("can include method context and sub-second precision", () => {
		expect(
			formatMcpTimeoutErrorMessage("slow-server", 1_500, "initialize"),
		).toBe(
			'MCP request to "slow-server" (initialize) timed out after 1.5s. Increase the "timeout" field (in seconds) for this server in cline_mcp_settings.json.',
		);
	});
});
