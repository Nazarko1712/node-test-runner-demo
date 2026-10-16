import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * ESLint 9 flat config.
 *
 * The point of this repo is that `node --test` needs no dependencies, so the
 * lint setup stays in the same spirit: the two ESLint packages and Prettier,
 * no plugin for the runner itself. `node:test` does not need one — `only` is
 * inert unless you pass `--test-only`, so there is no `no-focused-tests`
 * failure mode to guard against, which is a genuine design advantage over
 * Jest's `test.only`.
 *
 * What is still worth enforcing without a type checker:
 *
 *   no-unused-vars    an imported-but-unused helper is usually a test that was
 *                     half-rewritten
 *   require-await     an async function with no await is normally a forgotten
 *                     await inside it
 *   no-return-await   hides the stack frame of a rejection
 *
 * `no-floating-promises` is deliberately absent: it requires type information,
 * and this repo has no TypeScript. The compensation is that `node:assert` is
 * synchronous, so an un-awaited assertion throws an unhandled rejection and
 * the runner fails the test rather than passing it.
 */
export default [
    {
        ignores: ['node_modules/', 'test-results.xml', 'eslint.config.mjs'],
    },

    js.configs.recommended,

    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'require-await': 'error',
            'no-return-await': 'error',
        },
    },

    {
        files: ['test/**/*.js'],
        rules: {
            /**
             * Off in tests, on in `src/`.
             *
             * Every one of the 13 hits in `retry.test.js` is the same shape:
             *
             *     const operation = mock.fn(async () => 'ok');
             *
             * The `async` is the point — `retry()` is contracted to accept an
             * operation that returns a Promise, and a mock that returns a bare
             * value models a different contract than the one under test.
             *
             * Without type information the rule cannot tell "async because the
             * signature demands a Promise" from "async by accident", so in a
             * file full of hand-written async mocks it is wrong far more often
             * than it is right. Thirteen inline disables would be noise that
             * nobody reads; one scoped exemption with the reason attached is
             * honest. In `src/` the rule stays on, where an async function with
             * no await really is a forgotten await.
             */
            'require-await': 'off',
        },
    },

    prettier,
];
