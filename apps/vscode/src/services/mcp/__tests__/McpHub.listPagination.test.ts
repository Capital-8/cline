import { afterEach, beforeEach, describe, it } from "bun:test"
import "should"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sinon from "sinon"
import { McpHub } from "../McpHub"

/**
 * Unit tests for MCP list pagination in McpHub's fetch*List methods
 * (tools/list, resources/list, resources/templates/list, prompts/list).
 *
 * MCP servers may paginate list results with an opaque `nextCursor`
 * (https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination).
 * McpHub must follow every cursor so the catalog shown to the user and the
 * model is complete, and must bail out on a cursor it has already followed.
 *
 * These exercise the real fetch*List implementations through a partially
 * initialized `McpHub` (same pattern as McpHub.callTool.test.ts) with a
 * stubbed MCP SDK `Client.request`.
 */

type Page = Record<string, unknown>

/**
 * Builds a `Client.request` stub that serves `pages` in order, keyed by the
 * cursor the previous page advertised, and records every cursor received.
 */
function createPagedClient(pages: Page[]) {
	const received: Array<string | undefined> = []
	const byCursor = new Map<string | undefined, Page>()
	let key: string | undefined
	for (const page of pages) {
		byCursor.set(key, page)
		key = typeof page.nextCursor === "string" ? page.nextCursor : undefined
	}
	const request = sinon.stub().callsFake(async (req: { method: string; params?: { cursor?: string } }) => {
		const cursor = req.params?.cursor
		received.push(cursor)
		const page = byCursor.get(cursor)
		if (!page) {
			throw new Error(`unknown cursor ${String(cursor)}`)
		}
		return page
	})
	return { request, received, getServerCapabilities: () => undefined }
}

function createMcpHub(client: ReturnType<typeof createPagedClient>, settingsDir: string) {
	const serverName = "paged-server"
	const connection = {
		server: {
			name: serverName,
			config: JSON.stringify({ type: "stdio", command: "test", timeout: 60 }),
			status: "connected",
			disabled: false,
		},
		client,
		transport: {},
	}
	const hub = Object.create(McpHub.prototype) as McpHub
	;(hub as any).connections = [connection]
	;(hub as any).getSettingsDirectoryPath = async () => settingsDir
	return { hub, serverName }
}

describe("McpHub list pagination", () => {
	let settingsDir: string

	beforeEach(async () => {
		settingsDir = await mkdtemp(join(tmpdir(), "cline-mcphub-pagination-"))
		await writeFile(
			join(settingsDir, "cline_mcp_settings.json"),
			JSON.stringify({ mcpServers: { "paged-server": { command: "test", autoApprove: ["get_ticket"] } } }),
		)
	})

	afterEach(async () => {
		await rm(settingsDir, { recursive: true, force: true })
	})

	it("follows tools/list cursors and keeps per-tool autoApprove across pages", async () => {
		const client = createPagedClient([
			{ tools: [{ name: "search_tickets", inputSchema: { type: "object" } }], nextCursor: "opaque:/page+2?token=a%3Db" },
			{ tools: [], nextCursor: "opaque:/page+3" },
			{ tools: [{ name: "get_ticket", inputSchema: { type: "object" } }] },
		])
		const { hub, serverName } = createMcpHub(client, settingsDir)

		const tools = await (hub as any).fetchToolsList(serverName)

		tools.map((t: { name: string }) => t.name).should.deepEqual(["search_tickets", "get_ticket"])
		tools[0].autoApprove.should.be.false()
		tools[1].autoApprove.should.be.true()
		client.received.should.deepEqual([undefined, "opaque:/page+2?token=a%3Db", "opaque:/page+3"])
		// The first page is requested without a `params.cursor`; later pages carry it.
		client.request.firstCall.args[0].should.deepEqual({ method: "tools/list" })
		client.request.secondCall.args[0].should.deepEqual({
			method: "tools/list",
			params: { cursor: "opaque:/page+2?token=a%3Db" },
		})
		client.request.getCalls().forEach((call) => call.args[2].should.deepEqual({ timeout: 60_000 }))
	})

	it("sends one tools/list request when the server does not paginate", async () => {
		const client = createPagedClient([{ tools: [{ name: "only", inputSchema: { type: "object" } }] }])
		const { hub, serverName } = createMcpHub(client, settingsDir)

		const tools = await (hub as any).fetchToolsList(serverName)

		tools.map((t: { name: string }) => t.name).should.deepEqual(["only"])
		client.request.calledOnce.should.be.true()
	})

	it("follows resources/list, resources/templates/list and prompts/list cursors", async () => {
		const client = createPagedClient([])
		const byMethod: Record<string, Page[]> = {
			"resources/list": [
				{ resources: [{ uri: "file:///a", name: "a" }], nextCursor: "r2" },
				{ resources: [{ uri: "file:///b", name: "b" }] },
			],
			"resources/templates/list": [
				{ resourceTemplates: [{ uriTemplate: "file:///{x}", name: "x" }], nextCursor: "t2" },
				{ resourceTemplates: [{ uriTemplate: "file:///{y}", name: "y" }] },
			],
			"prompts/list": [
				{ prompts: [{ name: "p1", arguments: [{ name: "q", required: true }] }], nextCursor: "p2" },
				{ prompts: [{ name: "p2" }] },
			],
		}
		client.request.callsFake(async (req: { method: string; params?: { cursor?: string } }) => {
			const pages = byMethod[req.method]
			return req.params?.cursor === undefined ? pages[0] : pages[1]
		})
		const { hub, serverName } = createMcpHub(client, settingsDir)

		const resources = await (hub as any).fetchResourcesList(serverName)
		const templates = await (hub as any).fetchResourceTemplatesList(serverName)
		const prompts = await (hub as any).fetchPromptsList(serverName)

		resources.map((r: { uri: string }) => r.uri).should.deepEqual(["file:///a", "file:///b"])
		templates.map((t: { uriTemplate: string }) => t.uriTemplate).should.deepEqual(["file:///{x}", "file:///{y}"])
		prompts.should.deepEqual([
			{
				name: "p1",
				title: undefined,
				description: undefined,
				arguments: [{ name: "q", description: undefined, required: true }],
			},
			{ name: "p2", title: undefined, description: undefined, arguments: undefined },
		])
		client.request
			.getCalls()
			.map((call) => [call.args[0].method, call.args[0].params?.cursor])
			.should.deepEqual([
				["resources/list", undefined],
				["resources/list", "r2"],
				["resources/templates/list", undefined],
				["resources/templates/list", "t2"],
				["prompts/list", undefined],
				["prompts/list", "p2"],
			])
	})

	it("reports a fetch failure (undefined) instead of a partial list when a cursor repeats", async () => {
		const client = createPagedClient([])
		client.request.callsFake(async (req: { params?: { cursor?: string } }) => ({
			tools: [{ name: "t", inputSchema: { type: "object" } }],
			// A -> B -> A: a cycle that a "same as last cursor" check would miss.
			nextCursor: req.params?.cursor === "A" ? "B" : "A",
		}))
		const { hub, serverName } = createMcpHub(client, settingsDir)

		const tools = await (hub as any).fetchToolsList(serverName)

		;(tools === undefined).should.be.true()
		client.request.callCount.should.equal(3)
	})
})
