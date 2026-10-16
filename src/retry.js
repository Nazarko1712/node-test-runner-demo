/**
 * Retry with exponential backoff and jitter.
 *
 * Written as the subject under test because it is the kind of utility a test
 * engineer actually ends up owning — and because retrying is exactly where
 * suites hide their worst bugs: a retry that masks a real failure, a backoff
 * that never backs off, a jitter that is not random, an abort that is ignored.
 *
 * Every one of those is asserted in `test/retry.test.js`.
 */

export class RetryError extends Error {
    constructor(message, { attempts, lastError }) {
        super(message);
        this.name = 'RetryError';
        this.attempts = attempts;
        this.lastError = lastError;
    }
}

/**
 * @param {() => Promise<T>} operation
 * @param {object} [options]
 * @param {number} [options.attempts=3]      total attempts, including the first
 * @param {number} [options.baseDelayMs=100] delay before the second attempt
 * @param {number} [options.factor=2]        multiplier per subsequent attempt
 * @param {number} [options.maxDelayMs]      ceiling for a single delay
 * @param {number} [options.jitter=0]        0..1 fraction of random variation
 * @param {(error: unknown) => boolean} [options.retryOn] decide per error
 * @param {AbortSignal} [options.signal]
 * @param {(info: {attempt: number, delayMs: number, error: unknown}) => void} [options.onRetry]
 * @param {() => number} [options.random]    injectable for deterministic jitter
 * @returns {Promise<T>}
 * @template T
 */
export async function retry(operation, options = {}) {
    const {
        attempts = 3,
        baseDelayMs = 100,
        factor = 2,
        maxDelayMs = Number.POSITIVE_INFINITY,
        jitter = 0,
        retryOn = () => true,
        signal,
        onRetry,
        random = Math.random,
    } = options;

    if (attempts < 1) throw new TypeError('attempts must be at least 1');

    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        // Checked before each attempt, not only between delays, so an already
        // aborted signal never performs any work at all.
        if (signal?.aborted) {
            throw new RetryError('aborted before attempt', { attempts: attempt - 1, lastError });
        }

        try {
            return await operation(attempt);
        } catch (error) {
            lastError = error;

            const isLast = attempt === attempts;
            if (isLast || !retryOn(error)) {
                throw new RetryError(
                    `failed after ${attempt} attempt(s): ${error?.message ?? error}`,
                    { attempts: attempt, lastError: error },
                );
            }

            const exponential = Math.min(baseDelayMs * factor ** (attempt - 1), maxDelayMs);
            // Jitter spreads retries so concurrent clients do not synchronise
            // into a thundering herd against a recovering service.
            const spread = exponential * jitter * random();
            const delayMs = Math.round(exponential - exponential * jitter + spread);

            onRetry?.({ attempt, delayMs, error });
            await sleep(delayMs, signal);
        }
    }

    /* c8 ignore next */
    throw new RetryError('unreachable', { attempts, lastError });
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);

        if (signal) {
            const onAbort = () => {
                clearTimeout(timer);
                reject(new RetryError('aborted while waiting to retry', { attempts: 0 }));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}
