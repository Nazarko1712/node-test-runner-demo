import { test, describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { retry, RetryError } from '../src/retry.js';

/**
 * Everything here comes from Node itself — `node:test` and `node:assert`.
 * No Jest, no Vitest, no Chai, no Sinon, no transpile step.
 *
 * Note the import list: `mock` replaces `jest.fn` / `vi.fn`, and
 * `assert/strict` replaces `expect`. The runner is invoked with `node --test`.
 */

describe('retry', () => {
    beforeEach(() => {
        mock.reset();
    });

    it('returns the first successful result without retrying', async () => {
        const operation = mock.fn(async () => 'ok');

        const result = await retry(operation, { attempts: 3, baseDelayMs: 1 });

        assert.equal(result, 'ok');
        // `mock.calls` is the native equivalent of jest.fn().mock.calls.
        assert.equal(operation.mock.callCount(), 1);
    });

    it('retries until the operation succeeds', async () => {
        let calls = 0;
        const operation = mock.fn(async () => {
            calls += 1;
            if (calls < 3) throw new Error(`attempt ${calls} failed`);
            return 'eventually';
        });

        const result = await retry(operation, { attempts: 5, baseDelayMs: 1 });

        assert.equal(result, 'eventually');
        assert.equal(operation.mock.callCount(), 3);
    });

    it('throws RetryError carrying the attempt count and last error', async () => {
        const operation = mock.fn(async () => {
            throw new Error('always broken');
        });

        await assert.rejects(
            () => retry(operation, { attempts: 3, baseDelayMs: 1 }),
            (error) => {
                assert.ok(error instanceof RetryError);
                assert.equal(error.attempts, 3);
                assert.equal(error.lastError.message, 'always broken');
                // The message must name the real cause — an error that only
                // says "retry failed" costs an hour of log reading.
                assert.match(error.message, /always broken/);
                return true;
            },
        );

        assert.equal(operation.mock.callCount(), 3);
    });

    it('passes the attempt number to the operation', async () => {
        const seen = [];
        await retry(
            async (attempt) => {
                seen.push(attempt);
                if (attempt < 3) throw new Error('not yet');
                return 'done';
            },
            { attempts: 3, baseDelayMs: 1 },
        );

        assert.deepEqual(seen, [1, 2, 3]);
    });

    describe('retryOn', () => {
        it('stops immediately on a non-retryable error', async () => {
            const operation = mock.fn(async () => {
                const error = new Error('bad request');
                error.status = 400;
                throw error;
            });

            await assert.rejects(() =>
                retry(operation, {
                    attempts: 5,
                    baseDelayMs: 1,
                    // A 4xx will never succeed on retry; retrying it only
                    // multiplies the wasted calls.
                    retryOn: (error) => error.status >= 500,
                }),
            );

            assert.equal(operation.mock.callCount(), 1);
        });

        it('keeps retrying a retryable error', async () => {
            let calls = 0;
            const operation = mock.fn(async () => {
                calls += 1;
                const error = new Error('upstream down');
                error.status = 503;
                if (calls < 3) throw error;
                return 'recovered';
            });

            const result = await retry(operation, {
                attempts: 5,
                baseDelayMs: 1,
                retryOn: (error) => error.status >= 500,
            });

            assert.equal(result, 'recovered');
            assert.equal(operation.mock.callCount(), 3);
        });
    });

    describe('backoff', () => {
        it('grows the delay exponentially', async () => {
            const delays = [];
            await assert.rejects(() =>
                retry(async () => { throw new Error('nope'); }, {
                    attempts: 4,
                    baseDelayMs: 10,
                    factor: 2,
                    onRetry: ({ delayMs }) => delays.push(delayMs),
                }),
            );

            // 10, 20, 40 — the assertion that catches a backoff which never
            // actually backs off, the most common bug in a retry helper.
            assert.deepEqual(delays, [10, 20, 40]);
        });

        it('caps the delay at maxDelayMs', async () => {
            const delays = [];
            await assert.rejects(() =>
                retry(async () => { throw new Error('nope'); }, {
                    attempts: 5,
                    baseDelayMs: 100,
                    factor: 10,
                    maxDelayMs: 500,
                    onRetry: ({ delayMs }) => delays.push(delayMs),
                }),
            );

            assert.deepEqual(delays, [100, 500, 500, 500]);
        });

        it('applies jitter deterministically when random is injected', async () => {
            const delays = [];
            await assert.rejects(() =>
                retry(async () => { throw new Error('nope'); }, {
                    attempts: 3,
                    baseDelayMs: 100,
                    factor: 1,
                    jitter: 0.5,
                    // Injecting the source of randomness is what makes a jitter
                    // test assertable at all.
                    random: () => 1,
                    onRetry: ({ delayMs }) => delays.push(delayMs),
                }),
            );

            // jitter 0.5 with random()=1 -> full base delay
            assert.deepEqual(delays, [100, 100]);
        });

        it('jitter of 0.5 with random()=0 halves the delay', async () => {
            const delays = [];
            await assert.rejects(() =>
                retry(async () => { throw new Error('nope'); }, {
                    attempts: 2,
                    baseDelayMs: 100,
                    factor: 1,
                    jitter: 0.5,
                    random: () => 0,
                    onRetry: ({ delayMs }) => delays.push(delayMs),
                }),
            );

            assert.deepEqual(delays, [50]);
        });
    });

    describe('abort', () => {
        it('performs no work when the signal is already aborted', async () => {
            const operation = mock.fn(async () => 'never runs');

            await assert.rejects(
                () => retry(operation, { signal: AbortSignal.abort(), baseDelayMs: 1 }),
                /aborted before attempt/,
            );

            // The point of checking before the attempt rather than only between
            // delays: an aborted call must not reach the network once.
            assert.equal(operation.mock.callCount(), 0);
        });

        it('stops waiting when aborted mid-backoff', async () => {
            const controller = new AbortController();
            const operation = mock.fn(async () => {
                throw new Error('fails');
            });

            const pending = retry(operation, {
                attempts: 5,
                baseDelayMs: 5_000,
                signal: controller.signal,
            });

            setTimeout(() => controller.abort(), 20);

            await assert.rejects(() => pending, /aborted while waiting to retry/);
            assert.equal(operation.mock.callCount(), 1);
        });
    });

    it('rejects an invalid attempt count', async () => {
        await assert.rejects(
            () => retry(async () => 'x', { attempts: 0 }),
            TypeError,
        );
    });
});

/**
 * `test.skip`, `test.todo` and `test.only` are built in. `only` requires the
 * `--test-only` flag, which is a deliberate guard: a forgotten `.only` cannot
 * silently shrink a CI run the way it can elsewhere.
 */
test.todo('add a circuit breaker once a real service needs one');
