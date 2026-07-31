# Sonnet 5 Adaptive Effort Router

![tests](https://github.com/gabrieln2805/adaptive-effort-router/actions/workflows/test.yml/badge.svg)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

A proxy in front of the Claude Messages API that:

1. Detects task complexity automatically (prompt length, tool count, tool-result turns already in the conversation).
2. Sets Claude Sonnet 5's `effort` level dynamically based on that complexity.
3. Routes the hardest, user-blocking tasks to **Claude Fable 5** instead of just maxing out Sonnet 5's effort.
4. Migrates callers off `temperature` / `budget_tokens` onto the current `effort` + adaptive-thinking API automatically.
5. Includes a tokenizer test harness and per-request/aggregate cost observability, with the Sonnet 5 introductory-pricing cliff (Aug 31 → Sep 1, 2026) modeled explicitly.

## Facts this was built against (verified, not assumed)

- **`effort` is a real, current parameter**: `output_config: { effort: "low"|"medium"|"high"|"xhigh"|"max" }`, paired with `thinking: { type: "adaptive" }`. Sonnet 5 defaults to `high`.
- **Breaking migration on Sonnet 5**: `thinking: { type: "enabled", budget_tokens: N }` (manual thinking) and non-default `temperature` / `top_p` / `top_k` both return **HTTP 400** — not a warning, a hard failure. This proxy strips those fields from incoming requests so old Sonnet-4.6-era caller code passes through unmodified during migration (`stripLegacySamplingParams` in `server.js`).
- **New tokenizer**: Sonnet 5 and Fable 5 share a tokenizer that produces ~30% more tokens than Sonnet 4.6's for the same text on average — independent testing puts it at roughly 1.42x for English, 1.33x for Spanish, 1.27x for Python, and near parity for Simplified Mandarin. This is **not an API shape change** (no code changes required to keep calls working), but it silently changes `max_tokens` headroom and cost. `scripts/tokenizer-comparison.js` measures the actual multiplier for your content against the real `count_tokens` endpoint, since the "~30%" headline figure is an average, not your number.
- **Pricing**: Sonnet 5 is $2/$10 per MTok (input/output) through **August 31, 2026**, then $3/$15 standard. Fable 5 is flat $10/$50 per MTok with no introductory discount. `lib/pricing.js` computes the applicable Sonnet 5 rate from wall-clock time so nothing needs manual updating on September 1st.
- **Fable 5 refusal behavior**: Fable 5 carries safety classifiers on cyber/bio/chem topics. When one fires, the API returns a normal **HTTP 200 with `stop_reason: "refusal"`** — not an error. A router that only checks for HTTP failures will ship refusals straight to users. This proxy checks `stop_reason` explicitly and falls back to Opus 4.8 (Anthropic's documented fallback target) on refusal.

## Routing policy

| Complexity tier | Blocking? | Model | Effort |
|---|---|---|---|
| low | — | Sonnet 5 | `low` |
| medium | — | Sonnet 5 | `medium` |
| high | no (background/batch) | Sonnet 5 | `xhigh` |
| high | yes (user is waiting) | **Fable 5** | `high` |

"Blocking" is caller-declared via `routing_hint: { blocking: true|false }` in the request body (defaults to `true`), since a proxy can't reliably infer from the payload alone whether the caller is a human waiting on a chat reply or a background worker that can afford to retry cheaply. Complexity itself is auto-detected from prompt character length, tool count, and existing tool-result turns — see `lib/complexity.js` for the exact thresholds and, importantly, the note on why character length (not a token estimate) is used for *routing*, while real `usage` token counts are used for *billing*.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) >= 18 (`node -v` to check)
- An Anthropic API key from the [Claude Console](https://console.anthropic.com)

### Install

```bash
git clone https://github.com/gabrieln2805/adaptive-effort-router.git
cd adaptive-effort-router
npm install
```

### Configure your API key

Copy the example env file and fill in your key:

```bash
cp .env.example .env        # macOS/Linux
copy .env.example .env      # Windows (cmd)
Copy-Item .env.example .env # Windows (PowerShell)
```

Then edit `.env` and set `ANTHROPIC_API_KEY=sk-ant-...`. The server loads `.env` automatically (via `dotenv`) — `.env` is gitignored, so your key never gets committed.

> Alternative, without a `.env` file: set the variable directly in your shell for the current session.
> - bash/zsh: `export ANTHROPIC_API_KEY=sk-ant-...`
> - PowerShell: `$env:ANTHROPIC_API_KEY = "sk-ant-..."`

### Run

```bash
npm start        # starts the proxy on :8787
npm run dev      # same, but restarts on file changes (node --watch)
```

Send requests to `POST http://localhost:8787/v1/messages` exactly as you would to `https://api.anthropic.com/v1/messages`, plus the optional `routing_hint` field:

```bash
curl -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 200,
    "messages": [{"role": "user", "content": "Say hi in one sentence."}],
    "routing_hint": { "blocking": true }
  }'
```

Check `GET /observability/summary` for aggregate cost, routing mix, and a projection of what your Sonnet 5 spend looks like after the intro pricing expires.

## Testing

```bash
npm test                # routing + pricing suites together, no API key needed
npm run test:routing    # routing + refusal-fallback logic only
npm run test:pricing    # pricing math + the Aug 31 cutoff only
npm run test:tokenizer  # requires ANTHROPIC_API_KEY — compares real token counts, Sonnet 4.6 vs Sonnet 5, across prose/code/JSON/tool-heavy samples
```

`npm test` runs automatically on every push/PR via GitHub Actions (see `.github/workflows/test.yml`). The tokenizer test is intentionally excluded from CI since it calls the real API and costs real usage.

## Project structure

```
adaptive-effort-router/
├── .github/
│   └── workflows/
│       └── test.yml            # CI: runs npm test on push/PR across Node 18/20/22
├── lib/
│   ├── complexity.js           # complexity detector (prompt length, tool count, tool-result turns)
│   ├── router.js                # model/effort routing decision + Fable 5 refusal-fallback check
│   ├── pricing.js               # pricing table + cost calculation, incl. the intro-rate cliff
│   └── observability.js         # event recording + aggregate summary + post-cliff cost projection
├── scripts/
│   └── tokenizer-comparison.js  # empirical tokenizer test harness (real count_tokens calls)
├── test/
│   ├── routing.test.js          # no API key required
│   └── pricing.test.js          # no API key required
├── server.js                    # the proxy itself
├── .env.example                 # copy to .env and fill in your key
├── .gitignore
├── LICENSE                      # MIT — update the copyright holder before publishing
├── package.json
└── README.md
```

## What this doesn't do

This is a reference implementation, not a production gateway: no auth on the proxy's own endpoints, no retries/backoff on transient upstream errors, no persistent storage for observability events (in-memory only — restart loses history), and the complexity heuristic is intentionally simple (character length + tool count) rather than a learned classifier. Swap `ObservabilityTracker.record()` for a real metrics sink and add a durable request log before running this in front of real traffic.


## License

[MIT](./LICENSE)
