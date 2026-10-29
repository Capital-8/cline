import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDefaultMcpServerClientFactory } from "./client";
import type { McpServerClient, McpToolDescriptor } from "./types";

/**
 * Regression coverage for MCP `tools/list` pagination
 * (https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)
 * through the two real transports: a stdio child process and a Streamable
 * HTTP endpoint driven by the actual MCP SDK client.
 *
 * The fixture server keeps a log of the `tools/list` cursors it received and
 * how many times it was initialized, and reports both through `tools/call`,
 * so each test can assert that later pages were fetched on the same
 * connection and in the right order.
 */

type Page = { tools: McpToolDescriptor[]; nextCursor?: unknown };
type Scenario = {
	pages: Page[];
	/** Reject the request for the second page. */
	failOnSecondPage?: boolean;
	/** Alternate between two cursors forever (A → B → A → ...). */
	cycle?: boolean;
};

type JsonRpcRequest = {
	id?: string | number;
	method: string;
	params?: { cursor?: string; protocolVersion?: string; name?: string };
};

// Self-contained (no closures over module scope) so it can be stringified
// into the stdio child's script and run there unchanged.
function makeResponder(scenario: Scenario) {
	let initializations = 0;
	const cursors: Array<string | null> = [];
	return (request: JsonRpcRequest) => {
		if (request.id === undefined) {
			return undefined;
		}
		let result: unknown;
		if (request.method === "initialize") {
			initializations++;
			result = {
				protocolVersion: request.params?.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "pagination-fixture", version: "1.0.0" },
			};
		} else if (request.method === "tools/list") {
			const cursor = request.params?.cursor;
			cursors.push(cursor ?? null);
			if (scenario.cycle) {
				result = {
					tools: [],
					nextCursor: cursor === "A" ? "B" : "A",
				};
			} else {
				const index =
					cursor === undefined
						? 0
						: scenario.pages.findIndex((page) => page.nextCursor === cursor) +
							1;
				if (scenario.failOnSecondPage && index === 1) {
					return {
						jsonrpc: "2.0",
						id: request.id,
						error: { code: -32603, message: "later page failed" },
					};
				}
				const page = scenario.pages[index];
				if (!page) {
					return {
						jsonrpc: "2.0",
						id: request.id,
						error: { code: -32602, message: `unknown cursor ${cursor}` },
					};
				}
				result = page;
			}
		} else {
			result = {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							name: request.params?.name,
							initializations,
							cursors,
						}),
					},
				],
			};
		}
		return { jsonrpc: "2.0", id: request.id, result };
	};
}

const cursor = "opaque:/page+2?token=a%3Db";
const finalCursor = "opaque:/page+3?token=c%3Dd";
const first: McpToolDescriptor = {
	name: "search_tickets",
	description: "Search tickets",
	inputSchema: { type: "object" },
};
const last: McpToolDescriptor = {
	name: "get_ticket",
	description: "Get a ticket",
	inputSchema: { type: "object" },
	_meta: { ui: { resourceUri: "ui://tickets/detail" } },
};

describe.each(["stdio", "streamableHttp"] as const)(
	"MCP tool pagination (%s)",
	(transport) => {
		let tempRoot: string;
		const cleanups: Array<() => Promise<void>> = [];

		beforeAll(() => {
			tempRoot = mkdtempSync(join(tmpdir(), "cline-mcp-pagination-"));
		});

		afterEach(async () => {
			for (const cleanup of cleanups.splice(0).reverse()) {
				await cleanup();
			}
		});

		afterAll(() => {
			rmSync(tempRoot, { recursive: true, force: true });
		});

		async function createClient(scenario: Scenario): Promise<McpServerClient> {
			const settingsPath = join(tempRoot, "mcp.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({ mcpServers: { paged: {} } }),
			);
			const factory = createDefaultMcpServerClientFactory({ settingsPath });

			let client: McpServerClient;
			if (transport === "stdio") {
				const script = join(tempRoot, "server.cjs");
				writeFileSync(
					script,
					`
const respond = (${makeResponder.toString()})(${JSON.stringify(scenario)});
const input = require('node:readline').createInterface({ input: process.stdin });
input.on('line', (line) => {
  const response = respond(JSON.parse(line));
  if (response) process.stdout.write(JSON.stringify(response) + '\\n');
});
input.on('close', () => process.exit(0));
`,
				);
				client = await factory({
					name: "paged",
					transport: {
						type: "stdio",
						command:
							process.platform === "win32"
								? `"${process.execPath}"`
								: process.execPath,
						args: [script],
					},
				});
			} else {
				const respond = makeResponder(scenario);
				const server = createServer(async (request, response) => {
					if (request.method !== "POST") {
						response.writeHead(405).end();
						return;
					}
					const chunks: Buffer[] = [];
					for await (const chunk of request) {
						chunks.push(chunk);
					}
					const result = respond(
						JSON.parse(Buffer.concat(chunks).toString()),
					);
					if (!result) {
						response.writeHead(202).end();
						return;
					}
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(JSON.stringify(result));
				});
				await new Promise<void>((resolve) =>
					server.listen(0, "127.0.0.1", resolve),
				);
				cleanups.push(
					() =>
						new Promise<void>((resolve, reject) =>
							server.close((error) => (error ? reject(error) : resolve())),
						),
				);
				const port = (server.address() as { port: number }).port;
				client = await factory({
					name: "paged",
					transport: {
						type: "streamableHttp",
						url: `http://127.0.0.1:${port}/mcp`,
					},
				});
			}

			cleanups.push(() => client.disconnect());
			await client.connect();
			return client;
		}

		async function readServerState(client: McpServerClient) {
			const result = CallToolResultSchema.parse(
				await client.callTool({ name: last.name }),
			);
			const content = result.content?.[0];
			if (!content || content.type !== "text") {
				throw new Error("Expected server state");
			}
			return JSON.parse(content.text) as {
				name: string;
				initializations: number;
				cursors: Array<string | null>;
			};
		}

		it("discovers all pages on one connection and preserves later tool metadata", async () => {
			const client = await createClient({
				pages: [
					{ tools: [first], nextCursor: cursor },
					{ tools: [], nextCursor: finalCursor },
					{ tools: [last] },
				],
			});
			expect(await client.listTools()).toEqual([first, last]);
			expect(await readServerState(client)).toEqual({
				name: last.name,
				initializations: 1,
				cursors: [null, cursor, finalCursor],
			});
		});

		it("continues past an empty page when a cursor is present", async () => {
			const client = await createClient({
				pages: [{ tools: [], nextCursor: cursor }, { tools: [last] }],
			});
			expect(await client.listTools()).toEqual([last]);
		});

		it("keeps unpaginated discovery to one request", async () => {
			const client = await createClient({ pages: [{ tools: [last] }] });
			expect(await client.listTools()).toEqual([last]);
			expect((await readServerState(client)).cursors).toEqual([null]);
		});

		it("propagates a later-page error instead of returning a partial catalog", async () => {
			const client = await createClient({
				pages: [{ tools: [first], nextCursor: cursor }, { tools: [last] }],
				failOnSecondPage: true,
			});
			await expect(client.listTools()).rejects.toThrow("later page failed");
		});

		it("rejects a cursor that does not advance", async () => {
			const client = await createClient({
				pages: [
					{ tools: [first], nextCursor: cursor },
					{ tools: [last], nextCursor: cursor },
				],
			});
			await expect(client.listTools()).rejects.toThrow(
				'MCP server "paged" returned a repeated tools/list cursor',
			);
			expect((await readServerState(client)).cursors).toEqual([null, cursor]);
		});

		it("rejects a two-cursor cycle instead of paginating forever", async () => {
			const client = await createClient({ pages: [], cycle: true });
			await expect(client.listTools()).rejects.toThrow(
				"repeated tools/list cursor",
			);
			expect((await readServerState(client)).cursors).toEqual([
				null,
				"A",
				"B",
			]);
		});

		it("starts a fresh discovery from the first page each time", async () => {
			const client = await createClient({
				pages: [{ tools: [first], nextCursor: cursor }, { tools: [last] }],
			});
			await client.listTools();
			expect(await client.listTools()).toEqual([first, last]);
			expect((await readServerState(client)).cursors).toEqual([
				null,
				cursor,
				null,
				cursor,
			]);
		});

		if (transport === "stdio") {
			// The stdio client works from raw JSON with no schema validation, so
			// non-string cursors must terminate pagination rather than being
			// echoed back to the server.
			it("treats a null next cursor as the end of the tool list", async () => {
				const client = await createClient({
					pages: [{ tools: [first], nextCursor: null }, { tools: [last] }],
				});
				expect(await client.listTools()).toEqual([first]);
				expect((await readServerState(client)).cursors).toEqual([null]);
			});
		}
	},
);
