# Contributing

1. Use Node.js 22.19 or newer.
2. Run `npm install` for local development.
3. Keep the extension on public Pi APIs only; do not read Pi OAuth storage directly.
4. Add tests for parsing, formatting, request safety, and extension wiring when changing behavior.
5. Never add token, account-ID, or endpoint-body logging, persistence, or test fixtures.
6. Run `npm run verify` before opening a pull request.

The usage endpoint is undocumented/private. Changes to its payload handling must fail closed on unknown or malformed responses.
