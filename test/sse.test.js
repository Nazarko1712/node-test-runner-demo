import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, parseBlock } from '../src/sse.js';

describe('SSE block parsing', () => {
    it('parses id, event and data', () => {
        const event = parseBlock('id: 42\nevent: order.updated\ndata: {"orderId":7}');

        assert.deepEqual(event, {
            id: '42',
            event: 'order.updated',
            data: '{"orderId":7}',
        });
    });

    it('joins repeated data fields with a newline', () => {
        const event = parseBlock('data: first\ndata: second\ndata: third');

        // Multi-line payloads arrive as repeated data: lines, not as one line
        // containing "\n". Joining them wrongly corrupts every JSON payload
        // that happens to be pretty-printed.
        assert.equal(event.data, 'first\nsecond\nthird');
    });

    it('strips exactly one leading space, not all whitespace', () => {
        const event = parseBlock('data:  two spaces');

        // Per the spec a single space after the colon is the separator. Trimming
        // instead of slicing silently alters payloads that begin with a space.
        assert.equal(event.data, ' two spaces');
    });

    it('treats a line with no colon as a field with an empty value', () => {
        const event = parseBlock('data\ndata: real');

        assert.equal(event.data, '\nreal');
    });

    it('ignores comment lines used as keep-alives', () => {
        const event = parseBlock(': this is a keep-alive\ndata: payload');

        assert.equal(event.data, 'payload');
        assert.equal(Object.keys(event).length, 1);
    });

    it('returns null for a block with no data field', () => {
        // A retry:-only block adjusts the reconnect interval and dispatches
        // nothing. Returning an empty event here would surface a phantom
        // message to the consumer.
        assert.equal(parseBlock('retry: 1000'), null);
        assert.equal(parseBlock('id: 5\nevent: ping'), null);
    });

    it('parses retry as an integer and ignores a malformed one', () => {
        assert.equal(parseBlock('retry: 3000\ndata: x').retry, 3000);
        assert.equal(parseBlock('retry: later\ndata: x').retry, undefined);
    });

    it('ignores unknown fields instead of throwing', () => {
        const event = parseBlock('data: x\nfuturefield: y');

        // Forward compatibility: a server adding a field must not break an
        // existing client.
        assert.equal(event.data, 'x');
        assert.equal(event.futurefield, undefined);
    });
});

describe('SSE incremental parsing', () => {
    it('dispatches an event only once a blank line arrives', () => {
        const parser = new SseParser();

        assert.deepEqual(parser.push('data: incomplete'), []);
        assert.equal(parser.pending, 'data: incomplete');

        const events = parser.push('\n\n');
        assert.equal(events.length, 1);
        assert.equal(events[0].data, 'incomplete');
        assert.equal(parser.pending, '');
    });

    it('handles a chunk boundary that splits a field in half', () => {
        const parser = new SseParser();

        // A real socket splits wherever it likes. Parsing line-by-line without
        // buffering loses whatever straddles the boundary.
        assert.deepEqual(parser.push('data: hel'), []);
        const events = parser.push('lo\n\n');

        assert.equal(events[0].data, 'hello');
    });

    it('returns several events from a single chunk', () => {
        const parser = new SseParser();

        const events = parser.push('data: one\n\ndata: two\n\ndata: three\n\n');

        assert.deepEqual(events.map((e) => e.data), ['one', 'two', 'three']);
    });

    it('keeps a trailing partial event buffered across chunks', () => {
        const parser = new SseParser();

        const first = parser.push('data: complete\n\ndata: partial');
        assert.deepEqual(first.map((e) => e.data), ['complete']);
        assert.equal(parser.pending, 'data: partial');

        const second = parser.push('\n\n');
        assert.deepEqual(second.map((e) => e.data), ['partial']);
    });

    it('skips blocks that carry no data while keeping the ones that do', () => {
        const parser = new SseParser();

        const events = parser.push('retry: 1000\n\ndata: real\n\n');

        assert.equal(events.length, 1);
        assert.equal(events[0].data, 'real');
    });
});
