# Neruko

Neruko is a lightweight, mobile-first live chat experience powered by Cloudflare Workers, a Matchmaker Durable Object, and WebRTC.

## Development

- Runtime: Node.js 22+
- Install dependencies only if/when added; the current verification suite uses Node's built-in test/assert modules.
- Run checks with `npm test`.
- Worker configuration: `wrangler.jsonc`.

## Connectivity policy

- Random chat and rooms request one shared ICE configuration: Turnix is primary; Metered is requested only when Turnix credential issuance fails.
- If a live group/room peer connection using Turnix reaches a failed state, or remains disconnected for eight seconds, the deterministic offerer renegotiates that peer using Metered. The other peer switches when it receives the Metered renegotiation signal.
- Private friend conversations use independent WebRTC peer connections with relay-only ICE. They try Turnix first and Metered second, and can switch to Metered after a later Turnix connection failure.
- Provider credentials are fetched through the Worker and cached in the page for the current session. Provider API keys remain Worker secrets and are never sent to the browser.
- If both providers fail, the app reports that relay connectivity is unavailable; STUN may still permit direct connectivity for group/room chats, while private messages can use the live Worker relay.

## Required GitHub Actions secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `GEMINI_API_KEY`
- `TURNIX_API_TOKEN`
- `METERED_APP_NAME`
- `METERED_TURN_API_KEY`

Never commit secret values or paste them into issues or chat.

## Deployment from ZIP

Upload a ZIP named exactly `Neruko.zip` to the repository root. The ZIP deployment workflow validates the project, runs `npm test`, validates required secrets, deploys the Worker, uploads Worker secrets, and synchronizes the repository source. A failed check prevents deployment.

## Important verification boundary

Automated checks validate the Worker ICE endpoint, provider selection, secret isolation, signalling logic, and project regression suite. They cannot prove that external TURN credentials are currently valid or that carrier networks, restrictive Wi-Fi, and real devices complete ICE negotiation. Complete a two-device test on separate networks before treating a deployment as production-ready.
