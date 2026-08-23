# Deep Research Workflow (Kilo Agent)

Run autonomous deep-research using **this agent's own tools** (no Python package, no OpenAI key).
Methodology adapted from the `gpt-researcher` skill (planner → executor → publisher).

> Tavily and Context7 are already wired into the agent runtime. No `.env` key needed.
> If you want to use your own Tavily key instead, set `TAVILY_API_KEY` in `.env` - but it's optional here.

## Tools available in this agent
- `tavily_tavily-search` - web search (Tavily). Params: `query`, `max_results`, `search_depth` (`basic`|`advanced`), `topic` (`general`|`news`), `days`, `country`, `include_domains`, `exclude_domains`.
- `tavily_tavily-extract` - pull full content from specific URLs. Params: `urls`, `extract_depth`, `format`.
- `tavily_tavily-crawl` - crawl a site tree from a base URL.
- `tavily_tavily-map` - map a site's URL structure.
- `context7_*` - fetch up-to-date library docs (resolve lib id, then query).
- `webfetch` - fetch/convert a URL to markdown (fallback extractor).

## The research loop

### 1. Plan (Planner agent)
Given a `QUERY`, decompose into `BREADTH` (default 4) sub-questions that together answer it objectively.
For "deep" mode, each sub-question can spawn its own `DEPTH` (default 2) levels of subtopics (recursive tree).

### 2. Execute (Executor agents, in parallel)
For each sub-question:
- `tavily_tavily-search` with `search_depth: "advanced"` and `max_results: 8`.
- Pick top sources; `tavily_tavily-extract` (or `webfetch`) the most relevant 2–3 URLs for full text.
- For library/code questions, use `context7_resolve_library_id` + `context7_query_docs`.
- Track every claim with its source URL (citation).

Graceful degradation: if a source fails to extract, skip it and note it - never crash the run.

### 3. Publish (Publisher)
Aggregate all cited findings into a structured Markdown report:
- Executive summary
- Section per sub-question (with `##` headings)
- Bullet findings, each ending with `(source: <url>)`
- "Sources" section listing all URLs
- Optionally save the report to a file (e.g. `.kilo/research/<topic>-<date>.md`) when asked.

## Quick start (just tell the agent)
> "Do deep research on <topic>"  → planner→executor→publisher, breadth 4 / depth 2.
> "Research <topic> with breadth 6" → tune parameters.
> "Use context7 for <library>" → bias toward docs queries.

## Defaults (mirror gpt-researcher deep mode)
- BREADTH = 4 (subtopics per level)
- DEPTH = 2 (recursion levels)
- max_results per search = 8
- search_depth = advanced

## Example session
User: "Deep research: best practices for React + Vite production builds in 2026"
Agent:
1. Plan → sub-questions: bundling/code-splitting, caching, CI/CD, monitoring.
2. Execute → Tavily search + Context7 (vite, react) per sub-question, in parallel.
3. Publish → cited Markdown report, saved to `.kilo/research/react-vite-builds-2026-07-17.md`.
