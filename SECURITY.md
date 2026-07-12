# Security Policy

Report vulnerabilities privately through GitHub Security Advisories for this repository rather than opening a public issue.

## Security boundaries

Pi extensions run with the user's operating-system permissions. Review and pin releases before installing them.

This extension:

- uses only Pi's public extension APIs;
- checks `modelRegistry.isUsingOAuth()` against Pi's built-in `openai-codex` model before requesting usage;
- asks `modelRegistry.getApiKeyForProvider("openai-codex")` for a refreshed access token and never reads Pi auth files directly;
- decodes the JWT account-ID claim locally, without logging or persisting the token or claim;
- sends credentials only to the fixed `https://chatgpt.com/backend-api/wham/usage` URL, rejects redirects, and uses a 10-second timeout;
- never logs, persists, or exposes OAuth tokens, account IDs, or endpoint response bodies; and
- treats malformed or failed responses as unavailable and clears its footer.

`/backend-api/wham/usage` is an undocumented/private ChatGPT endpoint. Its behavior, availability, and security characteristics are controlled by OpenAI and are outside this package's control.
