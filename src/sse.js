/**
 * Server-Sent Events wire-format parser.
 *
 * The same format the Playwright project consumes over a real socket, isolated
 * here as a pure function so the parsing rules can be asserted directly instead
 * of through a server.
 *
 * Rules that actually bite, all covered in `test/sse.test.js`:
 *   - a blank line terminates an event; without one, nothing is dispatched
 *   - `data:` may repeat, and the values join with "\n"
 *   - exactly ONE leading space after the colon is stripped, not all whitespace
 *   - a line starting with ":" is a comment (used as a keep-alive) and ignored
 *   - a field with no colon is a field name with an empty value
 *   - an event with no `data` field is not dispatched at all
 */

/**
 * Incremental parser: feed it arbitrary chunks, get back completed events.
 * Chunk boundaries do not align with event boundaries on a real socket, which
 * is why this has to buffer rather than parse line-by-line in isolation.
 */
export class SseParser {
    #buffer = '';

    /**
     * @param {string} chunk
     * @returns {Array<{id?: string, event?: string, data: string, retry?: number}>}
     */
    push(chunk) {
        this.#buffer += chunk;
        const events = [];

        let boundary = this.#buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const block = this.#buffer.slice(0, boundary);
            this.#buffer = this.#buffer.slice(boundary + 2);

            const parsed = parseBlock(block);
            if (parsed) events.push(parsed);

            boundary = this.#buffer.indexOf('\n\n');
        }

        return events;
    }

    /** Anything still buffered has not been terminated by a blank line. */
    get pending() {
        return this.#buffer;
    }
}

/**
 * @param {string} block
 * @returns {{id?: string, event?: string, data: string, retry?: number} | null}
 */
export function parseBlock(block) {
    /** @type {{id?: string, event?: string, retry?: number}} */
    const fields = {};
    const dataLines = [];

    for (const line of block.split('\n')) {
        if (line === '') continue;

        // A leading colon marks a comment. Servers send bare ":" lines as
        // keep-alives to stop proxies closing an idle stream.
        if (line.startsWith(':')) continue;

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);

        // Per the spec exactly one space after the colon is removed — so
        // "data:  two spaces" keeps the second one.
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        switch (field) {
            case 'data':
                dataLines.push(value);
                break;
            case 'id':
                fields.id = value;
                break;
            case 'event':
                fields.event = value;
                break;
            case 'retry': {
                const ms = Number(value);
                if (Number.isInteger(ms)) fields.retry = ms;
                break;
            }
            default:
                // Unknown fields are ignored rather than throwing, so a server
                // adding a field does not break an existing client.
                break;
        }
    }

    // An event with no data field is not dispatched — a "retry:"-only block
    // adjusts the reconnect time and produces nothing.
    if (dataLines.length === 0) return null;

    return { ...fields, data: dataLines.join('\n') };
}
