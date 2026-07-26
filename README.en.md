# opendata-mcp

A unified [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) gateway to Taiwan's official open government data — ask Claude one plain-language question about weather, earthquakes, air quality, or traffic and get a real, live answer.

**👉 [See the visual overview page](https://opendata-mcp.dragonheartliu1440.workers.dev/)** — a faster way to understand what this project does than reading this plain-text README first.

[中文說明（README.md）](./README.md)

---

## What is this?

Taiwan's government agencies (Central Weather Administration, Ministry of Environment, Ministry of Transportation and Communications...) each publish open data, but every platform has its own signup flow, auth scheme, and field-naming conventions. Nobody wants to read API docs just to ask "will it rain in Taipei tomorrow?"

`opendata-mcp` is a Remote MCP Server deployed on Cloudflare Workers that collapses those scattered official APIs into one small set of easy-to-use tools. Once connected to Claude, you can just ask:

- "What's the weather forecast for Taipei tomorrow?"
- "Any recent earthquakes in Taiwan? How strong?"
- "Is the air quality good in New Taipei right now?"
- "Any incidents on National Freeway No. 3 right now?"
- "Is the TRA running late at Banqiao Station?"

No API keys to request yourself, no dataset codes to memorize, no dealing with agency-specific quirks — Claude calls this service, fetches the live data, and turns the official response into a readable answer.

**Current scope**: 9 curated tools (weather, earthquakes, typhoons, air quality, bus arrivals, YouBike, TRA rail, metro status, freeway incidents) + 2 generic query tools, spanning 4 data platforms (CWA, Ministry of Environment, TDX — Taiwan's Transportation Data eXchange, and the National Freeway Bureau). 19 datasets are registered in total, 8 of which are long-tail datasets with no dedicated tool but still queryable through the generic layer. See "Supported tools" below for the full list.

You can use the public demo deployment directly, or self-host your own (free, only needs a Cloudflare account) per the "Self-hosting" section below.

---

## Quick start

No coding required — a few minutes to connect this to your own Claude:

1. Open [claude.ai](https://claude.ai)
2. **Settings** (bottom left) → **Connectors**
3. Click **Add custom connector**
4. Paste this URL:

   ```
   https://opendata-mcp.dragonheartliu1440.workers.dev/mcp
   ```

5. Save, go back to your conversation, and try asking "What's the weather forecast for Taipei tomorrow?"

> ⚠️ **This is a public demo deployment for testing only** — no auth, no dedicated quota guarantee. Under heavier load it may respond slowly, be temporarily unstable, or run into shared upstream API rate limits used up by other users. For any long-term or reliable use — especially the TDX-backed tools (bus/YouBike/rail/metro) — self-hosting is strongly recommended (see below): it's free, and you run it against your own API keys and your own Cloudflare account quota.

---

## Connecting from other AI platforms

This server is built on the standard MCP protocol — it isn't Claude-specific, and works with any MCP-compatible AI platform, including ChatGPT, Cursor, Windsurf, and Cline.

### ChatGPT

**Settings → Apps & Connectors → Advanced settings → enable Developer Mode** → add a custom connector, enter the server URL (same as above), and set authentication to "None" (this service requires no authentication).

⚠️ **Known difference**: unlike Claude, ChatGPT doesn't always proactively decide on its own whether to call an external tool. When asking a question, explicitly mention this connector — e.g. "Use the OpenData MCP connector to check the weather in Taipei" — rather than a plain "what's the weather in Taipei", or ChatGPT may just answer from its own built-in knowledge or a web search instead of thinking to query live data.

### Cursor / Windsurf / Cline

Add this to your MCP servers configuration (usually a JSON config file):

```json
{
  "opendata-mcp": {
    "url": "https://opendata-mcp.dragonheartliu1440.workers.dev/mcp"
  }
}
```

No additional authentication configuration needed.

---

## Supported tools

### Curated tools (9, ready to use)

| Tool | What it does | Source agency | Update cadence |
| --- | --- | --- | --- |
| `tw_weather_forecast` | 36-hour forecast for a given county: conditions, rain probability, temperature, comfort index | CWA (F-C0032-001) | Several times a day |
| `tw_recent_earthquakes` | Recent significant-intensity earthquake reports: magnitude, depth, epicenter, max intensity per area | CWA (E-A0015-001) | Real-time as earthquakes occur |
| `tw_typhoon` | Currently active typhoons/tropical cyclones and CWA's own forecast track | CWA (W-C0034-005) | Every 6h while a system is active |
| `tw_air_quality` | Real-time AQI, PM2.5, PM10, O3 for a county or station | Ministry of Environment (aqx_p_432) | Hourly |
| `tw_bus_eta` | Real-time bus arrival estimates by city/route/stop | TDX (Transportation Data eXchange) | Live (~30s–1min) |
| `tw_youbike` | Real-time bike/dock availability for YouBike and similar bike-share systems | TDX | Batch updates (~1–3 min) |
| `tw_rail` | Real-time TRA (Taiwan Railway) arrival/departure board, delay minutes | TDX | Live (official ~2min latency) |
| `tw_metro_status` | Current operational status for Taipei/Kaohsiung/Taoyuan metro systems | TDX | Official batch cadence ~60s |
| `tw_highway_traffic` | Nationwide freeway incidents, construction, and lane closures | National Freeway Bureau | Official batch cadence ~60s |

> 💡 Full parameter details, format gotchas, and applicable/non-applicable scope for each tool are visible to Claude before it calls the tool — the tool's own `description` is the authoritative, always-current source. This table is just a summary.

### Generic tools (2, cover the long tail)

Beyond the 9 curated tools, this server also registers **8 long-tail datasets** — tide forecasts, weather station observations, weather warnings, daily-max and real-time UV index, typhoon warnings, air quality forecasts, and road sign (CMS) locations. These have no dedicated tool, but are fully queryable through:

| Tool | What it does |
| --- | --- |
| `tw_search_datasets` | Keyword search (e.g. "tide", "UV") across every dataset registered on this server, returning `datasetId` and its parameters |
| `tw_query_dataset` | Given a `datasetId` from `tw_search_datasets`, runs the actual query — only accepts registered ids, never arbitrary URLs, closing off any SSRF/proxy-abuse surface |

If what you need isn't one of the 9 curated tools above, try `tw_search_datasets` first — it may already be registered.

---

## Self-hosting

Free, and takes about 10–15 minutes — no server of your own required.

### Prerequisites: API keys

| Agency | Powers | Sign up | Required? |
| --- | --- | --- | --- |
| CWA | Weather, earthquakes, typhoons | [CWA Open Data member center](https://opendata.cwa.gov.tw/user/authkey) → register, request an Authorization Key | Yes — without it, weather/earthquake/typhoon tools won't work |
| Ministry of Environment | Air quality | [Environmental Data Open Platform](https://data.moenv.gov.tw/) → register, get an API KEY from the member area | Yes — without it, the air quality tool won't work |
| TDX | Bus, YouBike, rail, metro | [TDX registration](https://tdx.transportdata.tw/register) → create an application in the member center to get a Client ID / Client Secret | Yes — without it, bus/YouBike/rail/metro tools won't work |
| National Freeway Bureau | Freeway incidents | Not needed — fully public, no auth | **No key needed** |

> 💡 All free to request. You can deploy with only some keys set — a tool without its key returns a clear, actionable error (with the signup URL), instead of taking down the whole service; every other configured tool keeps working.

### Deploy steps

1. Fork this repo to your own GitHub account
2. Log into the [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Import an existing Git repository**, pick your fork, keep the defaults, deploy
3. On the Worker's **Settings → Variables and Secrets** page, add these as Secrets (not plain environment variables — keep keys out of logs/UI):

   | Secret name | Value |
   | --- | --- |
   | `CWA_API_KEY` | Your CWA authorization key |
   | `MOENV_API_KEY` | Your Ministry of Environment API key |
   | `TDX_CLIENT_ID` | Your TDX application's Client ID |
   | `TDX_CLIENT_SECRET` | Your TDX application's Client Secret |

4. **Create your own KV namespace for caching** (strongly recommended — faster responses, far fewer repeat calls to upstream APIs):
   - Run `npx wrangler kv namespace create CACHE` in your repo — it prints a namespace id
   - Open `wrangler.toml`, replace the `id` under `[[kv_namespaces]]` with your own (**don't reuse the id committed in this repo** — that belongs to this project's own demo deployment), commit and push
   - Skipping this is fine too — just delete the `[[kv_namespaces]]` block entirely; the server still works, it just hits the upstream API on every call and loses TDX OAuth token caching
5. From here on, every push to `main` auto-redeploys via Cloudflare's Git integration — no manual step needed

### Connect your own deployment to Claude

After deploying you'll get a URL shaped like:

```
https://<your-worker-name>.<your-account>.workers.dev/mcp
```

Follow steps 1–5 in "Quick start" above with this URL instead — same steps, just pointed at your own deployment running on your own API quota.

---

## Architecture

Four layers, each with one job, keeping the cost of adding a new dataset low (one registry entry + one transform function + one test):

```
tools/     MCP-facing interface. Curated tools are thin: validate input -> registry lookup -> cache -> envelope
registry/  One entry per dataset: param schema, URL-building rule, transform function, cache TTL, keywords
adapters/  One module per upstream source: auth injection, timeout/retry, response-envelope unwrapping, missing-value normalization
infra/     HTTP client (timeout/retry), KV cache, unified response envelope, error codes
```

Full layering rationale, design principles (faithful pass-through, source attribution, fail-loud vs. fail-soft), and interface definitions live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (Chinese); the enforceable, as-built rules and every verified upstream quirk are in [`AGENTS.md`](./AGENTS.md) (mixed Chinese/English).

---

## Quality assurance

Three GitHub Actions workflows provide continuous, automation-first quality gating — designed so contributors don't have to rely on manual verification:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`ci.yml`](./.github/workflows/ci.yml) | Every PR | Typecheck, run the full unit test suite (333 tests as of this writing), `wrangler deploy --dry-run` to confirm the build is deployable. Any failing step blocks merge. |
| [`fixtures-refresh.yml`](./.github/workflows/fixtures-refresh.yml) | Weekly (also manually triggerable) | Hits every registered dataset's real API and structurally diffs the response against `test/fixtures/` (field names/types, not values). On drift, auto-opens a PR labeled `schema-drift` with the updated fixture plus a notifying issue — catches an upstream format change before it becomes a silent production bug. |
| [`post-deploy-smoke-test.yml`](./.github/workflows/post-deploy-smoke-test.yml) | After every push to `main` (also manually triggerable) | Sends real MCP requests to the live deployment: `initialize` → `tools/list` (confirms every tool is actually exposed) → real calls to several tools, checking the response envelope shape. Failures auto-open an issue labeled `smoke-test-failed`. |

All three can be triggered manually from GitHub's **Actions** tab — no need to wait for the schedule or the next deploy.

---

## Data sources and licensing

All data surfaced by this project is released under Taiwan's [Government Open Data License, version 1](https://data.gov.tw/license):

- Weather forecasts, earthquake reports, typhoon bulletins: [CWA Open Data Platform](https://opendata.cwa.gov.tw/)
- Air Quality Index (AQI): [Ministry of Environment Open Data Platform](https://data.moenv.gov.tw/)
- Bus arrivals, YouBike, TRA arrival/departure board, metro status: [Transportation Data eXchange (TDX)](https://tdx.transportdata.tw/)
- Freeway incidents: [National Freeway Bureau's "Traffic Database"](https://tisvcloud.freeway.gov.tw/)

**Disclaimer**: This project is purely a pass-through/formatting layer over official open data — it **never generates, infers, or judges** any forecast, warning, or traffic content, and **does not guarantee data freshness or accuracy** (responses are cached briefly per dataset's own update cadence, so a delay of up to a few minutes is possible). For disaster preparedness, typhoon, earthquake, air-quality, or road-closure alerts, always defer to the official channels of CWA, the Ministry of Environment, MOTC and its subordinate agencies (their websites, official apps, or other official channels). This project provides no forecasting, alerting, or traffic-control service of its own, and assumes no liability for any loss arising from use of the data it surfaces.

---

## Contributing

PRs welcome. This project is deliberately structured so adding a new dataset is cheap — one registry entry + one transform function + one fixture + one test suite, with no need to touch any existing tool's code.

Before starting, please read:

1. [`AGENTS.md`](./AGENTS.md) — the as-built layer interfaces, the tool-description five-segment rule, testing requirements, and a running log of verified upstream quirks (which agencies' filter params can't be trusted, which datasets are unreachable from CI, etc). This is a living working-rules document; reading it first saves re-discovering the same pitfalls.
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the full architecture plan and design principles.

When opening a PR, please list: files touched (grouped by layer), any new registry entries, test count before/after, and any deviation from the architecture doc. Feel free to open an issue first if you want to discuss an approach.

---

## License

Code is [MIT licensed](./LICENSE) — use, modify, and redistribute freely.

The **data** obtained through this project is separately licensed under Taiwan's [Government Open Data License, version 1](https://data.gov.tw/license), independent of the code license — check that license's requirements (mainly attribution) before redistributing the data itself.
