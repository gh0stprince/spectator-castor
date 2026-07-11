# Contributing to Spectator

Thanks for helping improve Spectator. Keep changes focused on its read-only broadcasting mission.

## Before opening a pull request

1. Use Node.js 20 or newer.
2. Run `npm install` and `npm test`.
3. Run `npm run demo` and check the viewer when changing UI or event behavior.
4. Explain the user-facing effect and any safety implications in the pull request.

Please do not add dependencies or a build step without discussing the tradeoff in an issue first. Keep all Hermes gateway-frame knowledge in `src/adapter.js`, and never weaken redaction to make an event render. If a redaction rule changes, add coverage in `test/redact.test.js`.

Do not commit raw gateway recordings, credentials, viewer keys, `.env` files, or `.spectator/` state. Use synthetic credentials assembled at runtime in tests so repository secret scanners do not mistake fixtures for live secrets.

## Project scope

Good contributions improve safe, read-only spectating, protocol compatibility, reliability, accessibility, or operator setup. Chat input, remote control, accounts, analytics, and broad persistence are intentionally out of scope.

By contributing, you agree that your contribution is licensed under the MIT License.
