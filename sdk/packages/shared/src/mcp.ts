/**
 * Per-server MCP request timeout contract, in seconds.
 *
 * The `timeout` field in cline_mcp_settings.json is in SECONDS. Every client
 * (VSCode extension, CLI, JetBrains) resolves it through this module so all
 * apply the same default and bounds. Values above MAX are almost always a
 * milliseconds/seconds mix-up (e.g. `timeout: 60000` meaning 60s), so they
 * clamp instead of silently becoming hours.
 */
export const DEFAULT_MCP_TIMEOUT_SECONDS = 60; // matches Anthropic's default timeout in their MCP SDK
export const MIN_MCP_TIMEOUT_SECONDS = 1;
export const MAX_MCP_TIMEOUT_SECONDS = 3600;

export function isMcpTimeoutConfigured(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Clamp a timeout in seconds into [MIN_MCP_TIMEOUT_SECONDS, MAX_MCP_TIMEOUT_SECONDS].
 */
export function clampMcpTimeoutSeconds(value: number): number {
	return Math.min(
		Math.max(value, MIN_MCP_TIMEOUT_SECONDS),
		MAX_MCP_TIMEOUT_SECONDS,
	);
}

/**
 * Resolve a raw `timeout` value from MCP settings to seconds. Never throws:
 * missing or non-numeric values fall back to the default, so one malformed
 * field cannot take down a whole settings file.
 */
export function resolveMcpTimeoutSeconds(value: unknown): number {
	if (!isMcpTimeoutConfigured(value)) {
		return DEFAULT_MCP_TIMEOUT_SECONDS;
	}
	return clampMcpTimeoutSeconds(value);
}

/**
 * Upper bound on list pages (tools/list, resources/list, prompts/list, ...)
 * followed per discovery. Servers paginate in
 * pages of tens to hundreds of entries, so a well-behaved server never gets
 * near this; it exists so a server that keeps minting fresh cursors cannot
 * hold session startup (which waits on discovery) open indefinitely.
 */
export const MAX_MCP_LIST_PAGES = 1_000;

/**
 * One page of an MCP paginated list result (`tools/list`, `resources/list`,
 * `resources/templates/list`, `prompts/list`). The `nextCursor` is typed as
 * `unknown` because stdio clients hand over raw JSON: a server may send
 * `null` or a non-string, both of which end pagination rather than being
 * echoed back as a cursor.
 */
export interface McpListPage<T> {
	readonly items: readonly T[];
	readonly nextCursor?: unknown;
}

export interface CollectMcpPagesOptions<T> {
	/** Server name for error messages. */
	readonly serverName: string;
	/** Request method for error messages, e.g. `tools/list`. */
	readonly method: string;
	/**
	 * Fetches one page. Called with `undefined` for the first page and with
	 * the server's opaque `nextCursor` for each following page.
	 */
	readonly fetchPage: (cursor: string | undefined) => Promise<McpListPage<T>>;
	/** Override for tests; defaults to MAX_MCP_LIST_PAGES. */
	readonly maxPages?: number;
}

/**
 * Follows the MCP pagination protocol
 * (https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)
 * and returns every item across all pages, in server order, within the same
 * connection.
 *
 * Pagination ends when a page omits `nextCursor` or returns a non-string one.
 * A cursor that was already followed in this discovery (a self-repeat or a
 * longer A→B→A cycle) aborts with an error instead of looping, as does
 * exceeding `maxPages`. Errors from `fetchPage` propagate unchanged so callers
 * never see a silently partial catalog.
 */
export async function collectMcpPages<T>(
	options: CollectMcpPagesOptions<T>,
): Promise<T[]> {
	const maxPages = options.maxPages ?? MAX_MCP_LIST_PAGES;
	const items: T[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	let pageCount = 0;
	do {
		if (pageCount >= maxPages) {
			throw new Error(
				`MCP server "${options.serverName}" returned more than ${maxPages} ${options.method} pages; stopping pagination.`,
			);
		}
		const page = await options.fetchPage(cursor);
		pageCount += 1;
		items.push(...page.items);
		const nextCursor =
			typeof page.nextCursor === "string" && page.nextCursor.length > 0
				? page.nextCursor
				: undefined;
		if (nextCursor !== undefined) {
			if (seenCursors.has(nextCursor)) {
				throw new Error(
					`MCP server "${options.serverName}" returned a repeated ${options.method} cursor; stopping pagination.`,
				);
			}
			seenCursors.add(nextCursor);
		}
		cursor = nextCursor;
	} while (cursor !== undefined);
	return items;
}

export function formatMcpTimeoutErrorMessage(
	serverName: string,
	timeoutMs: number,
	method?: string,
): string {
	const methodText = method ? ` (${method})` : "";
	const seconds = Math.round(timeoutMs / 100) / 10;
	return (
		`MCP request to "${serverName}"${methodText} timed out after ${seconds}s. ` +
		`Increase the "timeout" field (in seconds) for this server in cline_mcp_settings.json.`
	);
}
