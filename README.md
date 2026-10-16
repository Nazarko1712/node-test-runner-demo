# node-test-runner-demo

Node's **built-in** test runner, with **zero dependencies**. No Jest, no Vitest,
no Chai, no Sinon, no transpile step — `node:test`, `node:assert`, and the
runner's native mocking and coverage.

```json
"devDependencies": {}
```

**27 tests, 99.46% line coverage.** Nothing is installed; `node --test` is the
whole toolchain.

## Prerequisites

| Requirement        | Notes                                                           |
| ------------------ | --------------------------------------------------------------- |
| **Node.js 20.11+** | `node:test` is stable from 20.0; `mock` and coverage need 20.11 |
| **Nothing else**   | no `npm install` required — there is nothing to install         |
| **No network**     | the suite is entirely offline                                   |

## Running

```bash
node --test                               # everything
node --test --watch                       # watch mode
node --test --test-reporter=spec          # readable output (TAP is the default)
node --test --experimental-test-coverage  # built-in coverage
node --test --test-concurrency=4          # control parallelism
node --test --test-only                   # honour test.only
node --test test/sse.test.js              # a single file
node --test --test-name-pattern="backoff" # filter by name
```

The npm scripts wrap the same commands, but the point of this repository is
that they are not needed:

```bash
npm test
npm run test:watch
npm run test:coverage
npm run test:junit     # JUnit XML for CI, also built in
```

## Why this exists

Because "which test runner do you use" usually gets an answer from a list of
three, and the fourth option ships with the platform. Being able to say _Node
has had a built-in runner since v18, it is stable since v20, and here is a suite
using it_ is a short answer that lands.

It is also genuinely the right choice sometimes: a library, a CLI, a small
service, or any project where adding 300 transitive dependencies to test 200
lines of code is the wrong trade.

## What the runner gives you natively

| Capability         | API                                           | Jest / Vitest equivalent  |
| ------------------ | --------------------------------------------- | ------------------------- |
| Suites and tests   | `describe`, `it`, `test`                      | identical                 |
| Assertions         | `node:assert/strict`                          | `expect`                  |
| Mock functions     | `mock.fn()`, `mock.callCount()`               | `jest.fn()` / `vi.fn()`   |
| Spies on methods   | `mock.method()`                               | `jest.spyOn` / `vi.spyOn` |
| Fake timers        | `mock.timers`                                 | `jest.useFakeTimers`      |
| Skip / todo / only | `test.skip`, `test.todo`, `test.only`         | identical                 |
| Concurrency        | `--test-concurrency`, `{ concurrency: true }` | `maxWorkers`              |
| Coverage           | `--experimental-test-coverage`                | `--coverage`              |
| Reporters          | `tap`, `spec`, `dot`, `junit`, custom         | reporters                 |
| Watch              | `--watch`                                     | `--watch`                 |

**`test.only` requires the `--test-only` flag.** That is a deliberate guard: a
forgotten `.only` cannot silently shrink a CI run the way it can in Jest, where
`forbidOnly` has to be configured to get the same protection.

## What it does not give you

Worth being straight about, because the answer to "why not always use it" is a
real list:

- **No `expect` API.** `node:assert` is adequate but blunter; matchers like
  `toMatchObject` or `toHaveBeenCalledWith` have to be written by hand.
- **No snapshot testing** before Node 22, and it is still basic.
- **No jsdom / browser environment.** Node only — this is not a front-end
  component testing tool.
- **No module mocking** that matches `jest.mock`. `mock.module` exists but is
  experimental and clumsier.
- **Smaller ecosystem.** No Allure plugin, no `expect-webdriverio`, far fewer
  reporters.

So: good for libraries, CLIs and pure logic. Reach for Jest or Vitest when you
need matchers, module mocking or a browser environment.

## What is under test

Two utilities a test engineer actually ends up owning, rather than a toy.

### `src/retry.js` — retry with exponential backoff

Retrying is where suites hide their worst bugs, and each one is asserted:

- **a backoff that never backs off** — `assert.deepEqual(delays, [10, 20, 40])`
  is the test that catches it, and the one most retry helpers lack
- **a cap that does not cap** — `[100, 500, 500, 500]` with `maxDelayMs: 500`
- **jitter that is not random** — made assertable by injecting the random
  source, so `random: () => 1` and `random: () => 0` give deterministic bounds
- **an abort that is ignored** — an already-aborted signal must produce **zero**
  calls, asserted with `callCount() === 0`, because a cancelled request must not
  reach the network even once
- **retrying what can never succeed** — `retryOn` stops on a 4xx after one
  attempt instead of multiplying wasted calls
- **an error that hides its cause** — the thrown `RetryError` must name the
  original failure, the attempt count and the last error

### `src/sse.js` — Server-Sent Events wire-format parser

The same format the
[Playwright project](https://github.com/Nazarko1712/playwright-ts-testing)
consumes over a real socket, isolated as a pure function so the parsing rules
can be asserted directly:

- a blank line terminates an event; without one, nothing is dispatched
- `data:` may repeat and the values join with `\n` — getting this wrong corrupts
  every pretty-printed JSON payload
- **exactly one** leading space is stripped, not all whitespace, so
  `data:  two spaces` keeps the second one
- a `:`-prefixed line is a keep-alive comment and is ignored
- a block with no `data` field dispatches **nothing** — a `retry:`-only block
  adjusts the reconnect interval, and returning an empty event there would
  surface a phantom message
- an unknown field is ignored rather than throwing, so a server adding a field
  does not break an existing client
- **chunk boundaries do not align with event boundaries.** A real socket splits
  wherever it likes, so the parser buffers; `handles a chunk boundary that
splits a field in half` is the test that proves it.

## Linting and reports

```bash
npm run lint          # ESLint 9, flat config
npm run lint:fix
npm run format        # Prettier, writes
npm run format:check  # Prettier, reports (this is what CI runs)
npm run test:junit    # JUnit XML via the built-in reporter
```

The point of this repo is that `node --test` needs no dependencies, so the lint
setup stays in the same spirit: two ESLint packages, Prettier, and no plugin for
the runner itself. `node:test` does not need one — `only` is inert unless you
pass `--test-only`, so there is no `no-focused-tests` failure mode to guard
against. That is a genuine design advantage over Jest's `test.only`, which
silently reduces a CI run to one test.

`require-await` is **on in `src/`, off in `test/`**, with the reason in the
config. Every hit in `retry.test.js` was the same shape:

```js
const operation = mock.fn(async () => 'ok');
```

The `async` is the point: `retry()` is contracted to accept an operation that
returns a Promise, and a mock returning a bare value models a different contract
than the one under test. Without type information the rule cannot tell "async
because the signature demands it" from "async by accident", so in a file of
hand-written async mocks it is wrong far more often than right. Thirteen inline
disables would be noise nobody reads; one scoped exemption with its reasoning
attached is honest.

### Reports

The runner ships reporters: `spec` and `dot` for humans, `junit` for CI, `tap`
because `node:test` speaks TAP natively. No `jest-junit`, no `mochawesome` — one
more thing the standard library already covers.

### Pre-push hook

```bash
npm install    # wires the hook up via npm's `prepare` lifecycle script
```

`.husky/pre-push` runs the same checks CI runs, before the push leaves the
machine. If any of them exits non-zero, **the push is aborted and nothing
reaches the remote**:

```
  push blocked — ESLint found problems
  fix:     npm run lint:fix
  bypass:  git push --no-verify
```

Three deliberate choices in it:

**It does not run the suite.** Lint, formatting and types are fast, offline and
deterministic — the whole hook finishes in about four seconds. The tests need a
browser and/or somebody else's demo API, so a hook that ran them would add a
minute to every push and would block whenever that server is asleep. Those
belong in CI, where a retry is free.

**It never fixes anything.** The hook calls the reporting variants, never
`--fix` or `--write`. A hook that rewrites files during `git push` pushes a
version you never reviewed and leaves the corrected files uncommitted in your
working tree. Being told what to run is better than being silently corrected.

**It is a pre-push hook, not pre-commit.** Commits are cheap and often
intermediate; blocking each one trains you to reach for `--no-verify` until the
hook is decoration. One check before the branch leaves the machine catches
exactly what CI would catch, without getting in the way of committing
work-in-progress.

`git push --no-verify` skips it entirely and lets CI be the judge — a legitimate
choice for a branch that is not finished.

### Where this runs in CI

Linting and formatting are their **own job**, not steps inside the test job.
They need no browser, no network and no secrets, and they finish in seconds, so
as a separate job they run concurrently with the suite: a formatting failure
does not wait behind a long test run, and a real test failure is not hidden
behind a formatting failure. Both verdicts arrive on their own.

CI runs the `--check` variants, never the formatter itself. A pipeline reports
on the branch it was asked to verify; it does not rewrite it.
