# Synth — Marketing Next Steps (9/15)

Three different problems, three different fixes — grounded in the actual state of the app/codebase as of this session.

---

## 1. SEO — the real constraint is architecture, not copy

Checked: `vercel.json` has exactly one rewrite (`/` → `/synth.html`). This is a **single URL, single static page, entirely client-rendered**. That's the binding constraint — no amount of meta-tag polish fixes "one page exists."

**What's already fine:**
- Title/meta just got updated to `"Synth: Instantly query any CSV file with SQL"` — keyword-forward, matches actual search intent ("query csv with sql," "sql on csv file").

**What's actually costing traffic:**
- **Zero long-tail content.** People searching "how to run sql on a csv file," "query csv without a database," "csv to sqlite online," "excel alternative for sql queries" have nowhere to land because there's no page targeting those phrases. This is the single biggest lever — a tool like this has an enormous programmatic-SEO surface (comparison pages, "how to" pages, use-case pages) that currently doesn't exist. This is `programmatic-seo` and `ai-seo` skill territory — worth a dedicated pass.
- **No schema.org markup.** A `SoftwareApplication` JSON-LD block (with `offers`/`price` for the $9.99 tier) is what gets the rich result in search — price, rating stub, "free to try" badge. Currently absent.
- **No sitemap/robots.txt** found in the repo root — trivial to add, currently not helping a 1-page site much, but matters the moment content pages get added.
- **og:image** — worth verifying it's an actual social-card-sized image (1200×630), not just the app logo, since that's what renders in Slack/Twitter/iMessage previews when someone shares a link.

**Fastest real move:** 3–5 static landing pages targeting specific intents ("SQL query tool for CSV files," "CSV to SQLite converter," "Excel alternative: query your spreadsheet with SQL") that funnel into the same app. Each is cheap to build (static HTML, same design system) and each is a new door search engines can open. → `programmatic-seo` + `site-architecture` job.

---

## 2. Upgrade desire — running the actual offer through the Value Equation

```
Value = (Dream Outcome × Perceived Likelihood) / (Time Delay × Effort & Sacrifice)
```

**Scoring the current Premium offer honestly:**

| Lever | Score | Why |
|---|---|---|
| Dream outcome | 5/10 | Feature list ("multi-table workspaces," "cross-table AI queries") describes *capabilities*, not the outcome someone actually wants. Nobody wants "relationship detection" — they want "stop exporting to Excel and manually VLOOKUP-ing two files together." |
| Perceived likelihood | 3/10 | **The weak lever.** Zero social proof anywhere in the premium modal — no "used by 4,200 analysts," no example query, no before/after. At $9.99 this matters less than on a $500 offer, but it's still free lift left on the table. |
| Time delay | 8/10 | Genuinely good — Stripe embedded checkout, instant unlock, one-time payment. The offer's real strength. |
| Effort & sacrifice | 8/10 | Also good — $9.99 is an impulse-buy price point, no subscription commitment, no setup. |

**The binding constraint is Perceived Likelihood, not price.** A fast, frictionless, cheap offer wrapped around a fuzzy outcome with no proof. "Just lower the price" would be the wrong move here — price isn't the problem.

**Six-part anatomy audit of the current Premium modal:**

| Component | Current state | Fix |
|---|---|---|
| Core deliverable | ✅ Clear, itemized (multi-table, rename, cross-table AI, 5x AI usage, relationships, 500k-row CSVs) | Keep, but reorder — lead with the one non-technical people care about most (probably "500,000-row files" or "multi-table," not "relationship detection") |
| Bonus stack | ❌ None | Even a small one changes the frame — e.g. "Premium also gets you priority AI response times" or "early access to new features" costs nothing to deliver and makes the $9.99 feel like more than the sum of the bullet list |
| Guarantee | ❌ Actively negative — Terms says *"non-refundable except where required by law"* | At $9.99, a blunt "no refunds" line is pure conversion friction for zero fraud-prevention benefit — nobody's chargeback-abusing a $9.99 one-time tool. Flip it to a real guarantee: "Not what you expected? Email us within 7 days, no questions." **Highest-leverage single change available** — see `references/guarantee-design.md` (offers skill) for why an unconditional guarantee outperforms conditional ones on low-ticket, one-time purchases specifically. |
| Scarcity/urgency | ❌ None | Not required at this price point, but real (not fake) scarcity is available and honest: *"Early-adopter price — $9.99 while Synth is in beta."* True today, creates a legitimate reason to act now, sets up a future price increase without anyone feeling burned. |
| Name | "Premium" (generic) | Low priority, but "Synth Pro" or "Synth Unlimited" reads more specific and more like a real product tier than the generic SaaS default |
| Price + payment | $9.99 one-time | This is `pricing` territory, not `offers` — but worth flagging: one-time-forever pricing for a tool with ongoing AI inference costs (already tracking 60/300-per-day AI limits) is an unusual structure. Not necessarily wrong, but worth a deliberate look with the `pricing` skill rather than assuming it's fixed. |

**First change to make:** rewrite the "non-refundable" line into an actual guarantee. One-line copy change, directly targets the weakest lever (perceived likelihood/risk), and the kind of fix that shows up in conversion within days, not months.

---

## 3. Overall usage — an activation/retention question, not an offer question

Quick hits grounded in what the app actually does today:

- **Lite Mode → Normal Mode conversion**: Lite users get walled off from Save Query and Dashboard with a sign-in prompt (built this session). Correct gating, but is there a *reason* to sign in beyond "you have to"? A "your queries sync across devices" pitch at the sign-in prompt would help.
- **The 50k-row cap added this session doubles as a retention signal** — anyone who hits it is a qualified upgrade lead by definition. Worth checking: does hitting the cap feel like a dead end, or a clear next step? (The premium modal opens automatically — good — but worth treating as a high-value moment, not just an error state.)
- **No re-engagement loop** — nothing pulls a Lite user back after their first session. A "come back and pick up where you left off" isn't really possible for Lite (nothing's saved), which is actually a stronger *reason* to convert to Normal than anything currently on the landing page.

This is really `onboarding` + `marketing-loops` scope for a full build-out.

---

## Recommended first move

The guarantee-language fix (5 minutes, direct hit on the weakest lever) and the "early adopter price" framing (5 minutes, real and honest scarcity) are both trivial copy edits, ready to make and deploy immediately. The programmatic-SEO pages and the onboarding loop work are bigger, separate projects to scope later.

---

## Open / to revisit

- [ ] Ship the guarantee copy fix (Terms modal + Premium modal + Settings)
- [ ] Ship the "early adopter pricing" framing
- [ ] Scope 3–5 programmatic-SEO landing pages (intent list above)
- [ ] Add `SoftwareApplication` JSON-LD schema
- [ ] Add sitemap.xml / robots.txt
- [ ] Verify og:image is a real 1200×630 social card
- [ ] Revisit one-time vs. subscription pricing model given ongoing AI inference cost (`pricing` skill)
- [ ] Design a Lite → Normal sign-in pitch beyond "you have to"
- [ ] Design a re-engagement loop for Normal-tier accounts

---

## 4. AI SEO / GEO — becoming the cited answer for "query a CSV without SQL Server"

*(Added 9/15, second pass — analyzed using the `ai-seo` skill)*

The target isn't ranking on Google. It's being the thing ChatGPT/Perplexity/Claude/Gemini actually names when someone asks a question like these in a chat, not a search box.

### The query space (fan-out set)

AI systems don't answer one query in isolation — they fan out to related phrasings and synthesize across all of them. Covering the *topic*, not one exact keyword, is what gets Synth retrieved. The cluster around this intent:

- "how to query a csv without setting up sql server"
- "how to query a database without sql"
- "run sql on a csv file"
- "sql query tool for csv online"
- "query a spreadsheet with sql"
- "csv to sqlite without installing anything"
- "excel alternative to run sql queries"
- "analyze csv with ai instead of sql"
- "no-code sql for csv files"
- "ask questions about my data without writing sql"
- "browser based sql editor, no install"

Note the two different intents mixed in here — worth calling out because Synth is one of the few tools that genuinely serves *both*:
1. **"Give me real SQL, but skip the setup"** — people who know SQL and just don't want to stand up a server/database for a one-off file.
2. **"Let me skip SQL entirely"** — people who want an answer in plain English, no query language at all.

Synth's actual architecture (SQLite running client-side via sql.js, plus the AI Assistant's General Mode for plain-English answers) means it isn't stretching to claim either audience — it's structurally true for both. That's a real differentiator worth naming explicitly in content, not just implying.

### The core problem right now: there's nothing to retrieve

Checked the actual site again with this specific lens: **zero indexable content contains any of the above phrasings.** The one existing page (`synth.html`) is UI copy — "Upload your CSV," "Start with your email" — not problem/solution language. An AI system can't cite a page for solving "query a csv without sql server" if no crawlable text on the internet ties Synth to that exact problem. This is upstream of everything else in this section — structure, authority, and schema markup are all wasted effort on a page that doesn't exist yet.

**This has to be fixed before anything else in this section matters.**

### Pillar 1 — Structure: the page(s) to build

One dedicated, crawlable page (not gated behind the app UI) that answers the cluster directly. Draft structure:

**Definition block (first paragraph, self-contained, ~40–60 words):**
> Synth lets you run real SQL directly on a CSV file — no SQL Server, no Postgres, no database to install or host. Upload a file and it loads into a live SQLite database running entirely in your browser tab. Query it with actual SQL, or just ask in plain English if you'd rather skip SQL altogether.

**Comparison table** (comparison tables are still a strong citation format on Google AIO/Gemini/Perplexity, per the ai-seo skill's format data):

| Option | Setup required | Real SQL? | Works on a single CSV? |
|---|---|---|---|
| Synth | None — browser only | Yes | Yes |
| SQL Server / Postgres | Install + host a database | Yes | Overkill for one file |
| Google Sheets `QUERY()` | None | No (its own syntax) | Yes |
| Excel Power Query | None | No | Yes |
| Python (pandas/duckdb) | Install Python + libraries | Yes (duckdb) | Yes, but requires code |
| ChatGPT Code Interpreter | None | Indirect (via generated Python) | Yes, but not a standalone tool |

**FAQ block** — natural-language questions, matching real phrasing (also the strongest single format for direct extraction):
- "Can I query a CSV file without setting up a database?"
- "How do I run SQL on a spreadsheet or CSV?"
- "Is there a way to query data without knowing SQL?"
- "Does this require installing anything?"
- "How is this different from Google Sheets QUERY or Excel?"

**Step-by-step block**: "Upload a CSV → it becomes a SQLite database instantly → write SQL or ask in plain English → done." Three steps, numbered, no fluff — this is the extractable version of "how it works."

### Pillar 2 — Authority: what's currently missing

- **Stats with real numbers** (+37–40% citation boost per the Princeton GEO research cited in the skill): Synth already has real numbers to use — "supports CSVs up to 500,000 rows," "runs 100% client-side, no data ever leaves your browser." These are concrete, verifiable, and currently not stated anywhere in crawlable copy.
- **Freshness signal**: a visible "last updated" or changelog — AI systems weight recency.
- **No author/expertise attribution anywhere** — even a simple "Built by [name], a [background] frustrated with spinning up Postgres for one-off CSVs" gives E-E-A-T signal and, honestly, is probably just the true origin story.

### Pillar 3 — Presence: where this actually gets cited from

Per the skill: brands are 6.5x more likely to get cited via third-party sources than their own domain. For a query like "how to query a csv without sql server," the realistic near-term citation sources are:

- **Reddit** — r/SQL, r/dataisbeautiful, r/excel, r/analytics threads where this exact question gets asked constantly. Authentic participation (answering real questions, mentioning Synth where it's genuinely the right answer), not drive-by promotion.
- **Stack Overflow** — "how to query a csv file with sql" is a recurring question tag; a genuine, useful answer that happens to mention Synth is a durable citation source.
- **Hacker News / Product Hunt launch** — both get crawled and both are exactly the kind of "third-party, authoritative, recent" source AI engines favor.
- **Dev.to / small technical blog roundups** — "tools for querying CSV files" listicle-style roundups (though note: per the skill, ChatGPT's Aug 2026 update demoted listicle citations ~50% — treat these as a Google AIO/Perplexity play, not a ChatGPT play specifically).

### Machine-readable files (cheap, high-leverage, currently absent)

**`/llms.txt`** — draft:
```
# Synth

Synth lets you query any CSV file with real SQL, or in plain English,
directly in your browser. No database setup, no SQL Server, no
installation — upload a CSV and it becomes a live SQLite database
running client-side.

## Who it's for
- People who know SQL and don't want to set up a server for one file
- People who don't know SQL and want to ask questions in plain English
- Analysts working with CSVs up to 500,000 rows

## Key pages
- Pricing: /pricing.md
- App: /
```

**`/pricing.md`** — straightforward given the tier structure already built this session (Lite/Normal/Premium, $9.99 one-time for Premium) — currently no machine-readable version exists, meaning an AI agent comparing tools on a user's behalf can't currently parse Synth's pricing at all.

**Schema markup** — a `SoftwareApplication` block with `description` written in the same problem/solution language as the definition block above (not generic marketing copy), plus `FAQPage` schema wrapping the FAQ block.

### Monitoring — how to know if any of this is working

DIY monthly check (per the skill, since dedicated tools like Otterly/Peec are probably overkill at this stage): run the fan-out query list above through ChatGPT, Perplexity, and Google 3–5 times each, log whether Synth gets mentioned, and track the *rate* over time rather than one-off runs (AI answers are non-deterministic).

### Checklist — AI SEO / GEO

- [ ] Build one dedicated, crawlable "query a CSV without SQL Server" page (definition block, comparison table, FAQ, step-by-step) — this unblocks everything else in this section
- [ ] Add `/llms.txt` at the site root
- [ ] Add `/pricing.md` at the site root
- [ ] Add `SoftwareApplication` + `FAQPage` schema (ties into the schema item already in the checklist above)
- [ ] Verify robots.txt doesn't block GPTBot, PerplexityBot, ClaudeBot, or Google-Extended (no robots.txt currently exists — needs to be created either way)
- [ ] Write and publish a genuine Product Hunt / Hacker News launch post
- [ ] Identify 5–10 live Reddit/Stack Overflow threads asking this exact question and answer authentically where Synth is the right fit
- [ ] Set up the monthly DIY AI-visibility check (fan-out query list × ChatGPT/Perplexity/Google, 3–5 runs each)

---

## 5. Schema & technical SEO weak points

*(Added 9/15, third pass — analyzed using the `schema` skill, verified against the live production site, not guessed)*

Pulled the actual live HTML, response headers, and OG image and checked them directly. Every finding below is confirmed against the real site, not inferred.

### Findings

| # | Weak point | Evidence | Severity |
|---|---|---|---|
| 1 | **Zero structured data anywhere on the page** | `grep -c "application/ld+json"` on the live page returns `0` | High — this is the literal gap the `schema` skill exists to close. No `SoftwareApplication`, `Organization`, or `WebSite` markup means Google has no structured signal for what this product is, what it costs, or who publishes it. |
| 2 | **Two competing H1 tags, and neither states the page's topic** | Live HTML has `<h1>Start with your email.</h1>` (landing panel) *and* a second `<h1>Your workspaces</h1>` (dashboard view) — both present in the DOM simultaneously since this is a single-page app with hidden panels | High — duplicate H1s dilute topical signal, and neither H1 contains "SQL," "CSV," or "query." The heading hierarchy actively obscures what the product does instead of reinforcing it. |
| 3 | **`og:image` is a relative path, not absolute** | `<meta property="og:image" content="synth-cream-orangediscs.png">` — the Open Graph spec requires a fully-qualified URL; several crawlers (Facebook's in particular) don't reliably resolve relative paths against the page base | Medium-high — real risk that shared links show no preview image on Facebook/LinkedIn/Slack |
| 4 | **`og:image` is the wrong aspect ratio and reuses the header logo** | Fetched the actual file: 2176×722px = ~3:1 ratio. Recommended OG aspect ratio is ~1.91:1 (e.g. 1200×630). It's also literally the small header logo graphic, not a purpose-built social card | Medium — even once the path is fixed, this image will get cropped awkwardly on most platforms |
| 5 | **No Twitter/X card data beyond `twitter:card=summary`** | No `twitter:image`, `twitter:title`, or `twitter:description` present | Medium — shares on X currently render with minimal or no preview |
| 6 | **No `robots.txt`** | `curl` returns `404` | Low today (default is allow-all with no file), but blocks the sitemap-reference pattern and any future crawl-budget management once more pages exist |
| 7 | **No `sitemap.xml`** | `curl` returns `404` | Low today (one URL doesn't need one), but this is the same finding as Section 1 — becomes necessary the moment the programmatic-SEO pages ship |
| 8 | **No canonical tag** | Not present in `<head>` | Low today, cheap to add now before it matters (query params, trailing-slash variants) |
| 9 | **Meta description sits right at the truncation edge** | Measured at 157 characters; Google typically truncates SERP snippets around 155–160 | Low — minor risk of an awkward mid-word cutoff in search results |
| 10 | **~24,500 words of indexable text, most of it not about SQL/CSV** | Stripped all HTML tags from the live page and counted words — the number is high because every modal (Terms, Privacy, Help, Settings) sits in the DOM at all times, just hidden via the `hidden` attribute, and Google generally still indexes hidden-but-present content | Medium — this dilutes topical relevance. A crawler sees a huge page that's mostly legal boilerplate and UI copy, with the actual "query CSV with SQL" value prop thin and not front-loaded |

### Fix plan

**1. Ship the structured data** (ready to use, adjust the `url`/`logo` once the final production domain is settled — currently testing against the Vercel-assigned domain, not a custom domain):

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "name": "Synth",
      "url": "https://YOUR-DOMAIN/",
      "logo": "https://YOUR-DOMAIN/synth-cream-orangediscs.png"
    },
    {
      "@type": "WebSite",
      "name": "Synth",
      "url": "https://YOUR-DOMAIN/"
    },
    {
      "@type": "SoftwareApplication",
      "name": "Synth",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web",
      "description": "Instantly query any CSV file with real SQL, or in plain English, directly in your browser. No database setup, no SQL Server, and nothing to install.",
      "offers": [
        { "@type": "Offer", "name": "Free", "price": "0", "priceCurrency": "USD" },
        { "@type": "Offer", "name": "Premium", "price": "9.99", "priceCurrency": "USD" }
      ]
    }
  ]
}
```
Add `FAQPage` schema once the FAQ content block from Section 4 ships — same page, `@graph` array, no separate file needed.

**2. Fix the heading hierarchy.** One `<h1>` per rendered view, and the landing page's H1 should carry the actual topic — e.g. swap `"Start with your email."` for something that states what Synth does, with the email prompt demoted to an H2/label. The Dashboard's `"Your workspaces"` H1 should become an H2 (it's a sub-view, not the page's primary topic).

**3. Fix the OG image**, two parts:
   - Make the `content` value a fully-qualified absolute URL (`https://YOUR-DOMAIN/synth-cream-orangediscs.png`, not the relative filename)
   - Build a real 1200×630 social card (not the header logo stretched/cropped) — worth pairing with the design pass once a final domain/brand asset set exists
   - Add matching `twitter:image`, `twitter:title`, `twitter:description` so X shares aren't broken either

**4. Add `robots.txt`** (even a minimal one, referencing the sitemap once it exists) and **`sitemap.xml`** — low effort, and both become load-bearing the moment Section 1's programmatic-SEO pages ship, so worth doing in the same pass as this rather than twice.

**5. Add a canonical tag** — `<link rel="canonical" href="https://YOUR-DOMAIN/">` — trivial, prevents any future duplicate-URL confusion.

**6. Trim the meta description** to comfortably under 155 characters.

**7. Re-balance the hidden content.** Not asking to delete the Terms/Privacy/Help text — just don't let it be the majority of what a crawler sees relative to the actual product description. The Section 4 content page (definition block, comparison table, FAQ) directly helps here too: it adds relevant, on-topic text that outweighs the legal boilerplate in the ratio.

### Checklist — schema & technical SEO

- [ ] Ship `SoftwareApplication` + `Organization` + `WebSite` JSON-LD (draft above, ready to adapt)
- [ ] Fix duplicate H1s — one per view, landing H1 states the actual product topic
- [ ] Fix `og:image` to an absolute URL
- [ ] Build a proper 1200×630 social card image (not the stretched header logo)
- [ ] Add `twitter:image` / `twitter:title` / `twitter:description`
- [ ] Add `robots.txt` (reference sitemap once it exists)
- [ ] Add `sitemap.xml` (do this alongside the Section 1 programmatic-SEO pages, not before)
- [ ] Add a canonical `<link>` tag
- [ ] Trim meta description to <155 characters
- [ ] Confirm final production domain before locking in any absolute URLs above (currently auditing against the Vercel-assigned domain)

---

## 6. Site architecture audit

*(Added 9/15, fourth pass — analyzed using the `site-architecture` skill, verified against the live production HTML)*

### Current state: there is no site architecture — there's one URL with hidden view-states

This is the headline finding, and it's the reason several items in Sections 1 and 5 exist in the first place: Synth isn't a multi-page site with an architecture problem, it's **a single URL** (`/` → `synth.html`) where every conceptual "page" — Dashboard, Settings, Help, About, Terms of Service, Privacy Policy, the Pricing/Premium panel — is a `<div>` toggled by a `hidden` attribute via JavaScript. None of them have their own URL, hash, or history state.

Confirmed directly in the code: `history.replaceState` is used exactly twice, both just to strip query params after a magic-link redirect or Stripe checkout — never to give a view its own address. The Dashboard tracks "what to return to" with a plain JS variable (`dashboardPreviousView`), not browser history. The browser back/forward buttons do nothing meaningful inside the app.

**Current "hierarchy" (what actually exists):**
```
/ (synth.html — everything lives here as hidden panels)
├── Landing view (default)
├── App view (post-upload)
├── Dashboard view      — no URL, JS-toggled
├── Settings modal       — no URL, JS-toggled
├── Help modal           — no URL, JS-toggled
├── About modal          — no URL, JS-toggled
├── Terms of Service     — no URL, JS-toggled
├── Privacy Policy       — no URL, JS-toggled
└── Premium/Pricing modal — no URL, JS-toggled
```

**Consequences, concretely:**
- Nobody can bookmark or send a direct link to Terms, Privacy, About, or **Pricing** — there is no `/pricing` URL at all today, even though pricing is one of the highest-intent pages on any SaaS site
- Google cannot index or rank any of these as separate results — a search for "synth pricing" or "synth terms of service" has nothing to find beyond the single homepage
- Middle-click / Cmd-click "open in new tab" doesn't work on any footer link, because they aren't links
- This is also *why* Sections 1, 4, and 5 all independently arrived at "add real pages" — it's the same root cause showing up three times from three different angles (SEO, AI citation, schema)

### Findings

| # | Issue | Evidence | Severity |
|---|---|---|---|
| 1 | **No page has its own URL** except the root | Confirmed: no hash routing, no `pushState` for views, `history.replaceState` used only for query-param cleanup | Glaring — root cause behind several other sections' findings |
| 2 | **Footer nav uses `<button onclick>`, not `<a href>`** | Live markup: `<nav class="landing-footer-links"><button onclick="openAboutModal()">About</button>...` | Glaring — a `<nav>` element containing buttons instead of links is a semantic mismatch (crawlers and screen readers expect `<nav>` to hold navigable links), and it's *why* these can never become real, shareable, indexable pages without a structural change, not just a copy change |
| 3 | **No Pricing page or link anywhere in the footer** | Footer only has About / Terms / Privacy. Pricing is reachable only via the "Go Premium" header button (a CTA, not a navigable page) | Moderate — Pricing is typically one of the top 3 most-linked-to, most-shared pages on a SaaS site, and here it structurally can't be linked to at all |
| 4 | **No breadcrumbs anywhere** (Dashboard, workspace views) | Not present in markup | Minor — low priority for a 1-level-deep app, but the Dashboard is arguably its own section and gives up a free internal-linking/orientation opportunity |
| 5 | **No persistent top-level nav** (no Features/Pricing/Blog-style header items) | Header contains only account-state buttons (Go Premium, Sign in, Load Sessions) | Minor / likely intentional — reasonable for a single-tool app, but worth naming as a deliberate choice rather than an oversight, especially once Section 1's content pages exist and need *some* way to be discovered from within the app |
| 6 | **No orphaned or broken interactive elements** | Checked all 78 distinct `onclick="fn(...)"` references against their definitions — every one resolves. No dead buttons. | ✅ Clean — noted for completeness, not a problem |

### Remediation plan

The fix isn't "rebuild this as a multi-page app" — that's a disproportionate response to a tool that works the way it does for good reasons (instant, no-reload, client-side SQL). The fix is **give the content that's genuinely content its own URLs, and leave the app state as app state.**

**Phase 1 — cheap, do alongside Section 5's technical-SEO pass:**
- Convert About, Terms of Service, and Privacy Policy from modals into real static pages at `/about`, `/terms`, `/privacy` (they're pure content — nothing about them requires being a JS-toggled overlay). Keep the in-app modal as a *convenience* shortcut if useful, but make the footer buttons real `<a href="/about">` links pointing at the real page.
- Fix the `<nav>` semantic mismatch as part of the same change — once the footer links are real anchors, this resolves itself.

**Phase 2 — the highest-value new page, and currently the biggest gap:**
- Ship a real `/pricing` page. Static, linkable, shareable, indexable — showing the same Free/Normal/Premium breakdown that's currently locked inside the "Go Premium" modal. This is the single most linkable, most search-intent-matching page a SaaS site can have, and Synth currently has zero version of it that isn't buried behind a JS modal.
- Add it to the footer alongside About/Terms/Privacy.

**Phase 3 — ties directly into Sections 1 and 4:**
- The programmatic-SEO content pages (Section 1) and the "query a CSV without SQL Server" page (Section 4) should be built as this same kind of real, routable page — not more modals. Once `/pricing`, `/about`, `/terms`, `/privacy` exist as real URLs, the sitemap from Section 5 has something to actually list.

**Lower priority / intentionally deprioritized:**
- Dashboard, Settings — these are authenticated, user-specific views. Giving them real URLs is a nicer-to-have (bookmarkable "my dashboard") but not an SEO issue since they're not meant to be publicly indexed anyway. Fine to leave as-is for now.

### Checklist — site architecture

- [ ] Convert About / Terms / Privacy from modals to real static pages (`/about`, `/terms`, `/privacy`)
- [ ] Change footer nav from `<button onclick>` to real `<a href>` anchor tags
- [ ] Build a real, standalone `/pricing` page — currently doesn't exist anywhere outside the Premium modal
- [ ] Add Pricing to the footer nav alongside About / Terms / Privacy
- [ ] Once the above exist, revisit Section 5's `sitemap.xml` — it now has real URLs worth listing
- [ ] Coordinate with Section 1 (programmatic-SEO pages) and Section 4 (AI-citation page) so all new content ships as real routable pages, not additional modals

---

## 7. Paywall / upgrade-flow audit

*(Added 9/15, fifth pass — analyzed using the `paywalls` skill, evaluated against the actual gates and modal built this session)*

Every Premium gate shipped this session (multi-CSV, table rename, cross-table AI, large-CSV cap) routes to the same single `#premium-modal`. Evaluated that modal, and each trigger's timing, against the skill's framework.

### The paywall screen itself, against the 7-component checklist

Pulled the live markup directly:

```html
<div class="section-label">Go Premium</div>
...
<ul class="premium-feature-list">
  <li>Multi-table workspaces — up to 10 tables in one workspace</li>
  <li>Table renaming — give a table a cleaner name than its raw filename</li>
  <li>Cross-table AI queries — the assistant writes joins across your tables</li>
  <li>More AI usage — 5x the daily limit on a free account</li>
  <li>Relationship detection — auto-suggested foreign keys you confirm yourself</li>
  <li>Large files — load CSVs up to 500,000 rows instead of 50,000</li>
</ul>
<p>$9.99, paid once. Not a subscription, so there's nothing to cancel later.</p>
```

| Component | Present? | Assessment |
|---|---|---|
| Headline | ⚠️ Weak | `"Go Premium"` — generic, not benefit-oriented, and identical no matter what action triggered it. The skill's template is `"Unlock [Feature] to [Benefit]"`; this doesn't name the feature the user just tried to use or the benefit they'd get. |
| Value demonstration | ❌ Missing | Zero preview, screenshot, or "with Premium you could..." — just a static bullet list. Someone who just tried to rename a table sees the *same* generic list as someone who just tried to upload a 6th CSV. |
| Feature comparison | ⚠️ Partial | A bullet list exists, but it's not a real comparison table (no current-plan-marked column, no side-by-side). Functional, not persuasive. |
| Pricing | ✅ Good | Clear, simple: "$9.99, paid once. Not a subscription." This is a genuine strength — already flagged as one in Section 2. |
| Social proof | ❌ Missing | No testimonials, no "X people upgraded," no usage stats. Same gap already flagged in Section 2's Value Equation audit (Perceived Likelihood scored 3/10 there for the same reason). |
| CTA | ⚠️ Generic | The embedded Stripe form's own button copy — functional, but not customized per-trigger ("Unlock multi-table workspaces" vs. a generic "Pay"). |
| Escape hatch | ✅ Present | A real `×` close button exists (`closePremiumPanel()`) — respects "Respect the No," doesn't trap the user. Minor: it's an icon, not explicit "Continue with Free" text, but functionally fine. |

### Trigger-point timing audit

| Trigger | What fires it | Timing assessment |
|---|---|---|
| Multi-CSV gate | Uploading a 2nd file (`uploadCSV`/`addTablesCSV`) | ⚠️ **Can fire before any value is experienced.** A brand-new user who drags 2 files at once on their very first action hits the full paywall before ever seeing the single-table product work. The skill's core principle is "value before ask" — this violates it for anyone whose *first* action happens to be a multi-file drop. |
| Table rename gate | Clicking the rename pencil (chip or Dashboard) | ⚠️ Same risk — renaming a table to something cleaner than the auto-slugified filename is often literally the *first* thing someone wants to do after upload, before they've gotten a single query result back. |
| Cross-table AI gate | Asking the AI a question that needs 2+ tables joined | ❌ **No paywall shown at all.** Confirmed in code — `buildSystemPrompt()` silently falls back to a single-table prompt with zero user-facing notice. This is worse than a blocking paywall: the user asks a legitimate question, gets an incomplete or wrong-scoped answer, and has no idea *why* — they're more likely to conclude "the AI is bad" than "this needs Premium." A missed upgrade moment **and** a trust/quality issue at the same time. |
| Large-CSV row cap | Uploading a file over 50,000 rows | ✅ **Best-timed of the four.** This fires on a genuine limit the user just personally hit with their own real data — exactly the "after value moment, before frustration" window the skill recommends. It's also the one place the flow offers no soft landing (see below). |

### Anti-pattern check

- **Hidden close button** — not present, clean pass.
- **Guilt-trip copy** — not present in the paywall itself. The *cancellation* confirmation modal ("You'll lose access to multi-table workspaces...") is loss-framed but factual and appropriately placed at cancellation, not used as upgrade pressure.
- **No cooldown / frequency limiting** — every gated action reopens the identical full modal every time, with no memory of a prior dismissal in the same session. Not a dark pattern, but a missed "respect the no" opportunity — the skill recommends a cool-down after a dismiss.
- **Blocking without a soft landing** — the row-cap gate fully rejects the file; there's no offered middle path like "load just the first 50,000 rows instead?" The user's only options are upgrade or find a smaller file. Worth considering as a genuine "continue without" escape hatch per the skill's anti-pattern guidance ("Conversion Killers → blocking critical flows").

### Suggested steps

1. **Give the cross-table AI gate an actual paywall moment.** Right now it's the only gate in the whole system with zero user-facing signal — highest-priority fix in this section, since it's simultaneously a lost conversion opportunity and a silent-failure trust issue. When a question needs a join and the account isn't Premium, show a short inline message in the chat ("This needs data from more than one table — that's a Premium feature") with a link to the same modal, instead of just quietly answering a narrower question.
2. **Make the modal context-aware.** Same underlying modal is fine to keep (no need to build four different UIs), but pass the trigger reason in and change the headline + lead bullet to match — "Unlock multi-table workspaces" when triggered by a 2nd CSV, "Unlock table renaming" when triggered by the pencil icon, etc. Cheap change (the trigger already knows which `featureKey` fired), disproportionate lift in relevance.
3. **Reconsider the multi-CSV / rename gate timing for brand-new accounts.** Not necessarily "never show it early" — but worth asking whether a first-session user should get one warning/nudge before the full paywall, versus a returning user who's already gotten value. Lower priority than #1 and #2.
4. **Add a soft landing to the row-cap gate.** Offer "load the first 50,000 rows instead" as an explicit alternative to a hard rejection, so the free tier still gets *some* usable outcome from their real file instead of a dead end.
5. **Social proof is the same gap as Section 2** — no duplicate work needed, just confirming the paywall screen itself is one more place that gap shows up, not a separate problem.

### Checklist — paywall / upgrade flow

- [ ] Add a visible, in-chat notice when cross-table AI is blocked (currently silent — highest priority)
- [ ] Make the premium modal's headline and lead bullet context-aware per trigger (`featureKey`-driven)
- [ ] Add a per-session cooldown so the same dismissed paywall doesn't reopen identically on every retry
- [ ] Add a "load the first 50,000 rows instead" soft-landing option to the row-cap rejection
- [ ] Revisit whether first-session multi-CSV/rename attempts deserve a softer nudge before the full paywall
- [ ] Once Section 2's social-proof / guarantee-copy fixes ship, confirm they're reflected in this modal too, not just the standalone Pricing page from Section 6

---

## 8. Launch-readiness audit — is Synth actually ready to go live to the world?

*(Added 9/15, sixth pass — analyzed using the `launch` skill against the live production deployment, not the local repo)*

**Short answer: not yet. One finding below is an outright launch blocker, verified directly against the live URL.**

### 🚨 Blocker: Stripe is in test mode on the live production site

Checked both the local file and the actual deployed page at `vercel-nine-zeta-17.vercel.app` — same result:

```
STRIPE_PUBLISHABLE_KEY = 'pk_test_51UE9r...'
```

The `pk_test_` prefix is unambiguous — this is Stripe's sandbox mode. Confirmed the secret key pairs with it (`sk_test_` in the env config). **Right now, nobody visiting the live site can actually give Synth money.** Checkout will run entirely in Stripe's test environment — either it silently "succeeds" with fake test-mode money, or fails depending on how the flow is exercised, but either way zero real revenue is possible in the current state.

This is the single most important thing to fix before any public traffic arrives. Everything else in this section is secondary to this one item.

**Fix:** Swap `STRIPE_PUBLISHABLE_KEY` in `synth.html` to the live `pk_live_...` key, and update `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` in Vercel's production environment variables to their live equivalents. Also worth noting: the checkout uses `betas: ['custom_checkout_payment_form_1']` — a Stripe **beta** API. Worth a quick check that this beta flag is still valid/stable before flipping to live keys, since beta APIs can change without the same stability guarantees as GA ones.

### Readiness Gate: Simple, Lovable, Complete

The skill's own framework says run this before anything else.

| Gate | Verdict | Why |
|---|---|---|
| **Simple** | ✅ Pass | One clear job — query a CSV with SQL or plain English. The tier system adds surface area but doesn't muddy the core loop. |
| **Lovable** | ⚠️ Conditional | The mechanics are genuinely good (real client-side SQLite, real AI assistant, fast Stripe checkout when it's live). But several rough edges found across Sections 1–7 are exactly the kind of thing that determines "lovable" vs. "tolerated" for a first-time visitor: no social proof anywhere (Section 2), a paywall that can fire before any value is delivered (Section 7), and an AI that silently gives incomplete answers with no explanation (Section 7, cross-table AI gate). None of these are launch-blocking on their own, but stacked together they're the difference between "I want to use this again" and "this felt unfinished." |
| **Complete** | ❌ Not yet | Two concrete stubs, beyond the Stripe blocker above: (1) the `datasets_user_filename_unique` bug diagnosed earlier this session is still unfixed — confirmed no new migration exists for it — meaning a real user who saves two workspaces built from same-named files gets a raw Postgres error (`duplicate key value violates unique constraint "datasets_user_filename_unique"`) surfaced directly in a JS `alert()`. That's about as raw an error experience as a product can ship. (2) No custom domain — confirmed zero domains configured on the Vercel project (`vercel domains ls` returns 0). Launching to "the world" on an auto-generated `vercel-nine-zeta-17.vercel.app`-style URL undermines credibility before anyone even reads the landing page. |

**Verdict on the gate:** this isn't "Stealth Mode" (over-polishing) — if anything the opposite risk applies here, since a huge amount of real work shipped this session very fast. The risk is closer to launching one step early: two concrete, fixable stubs (payments, the filename bug) plus one presentation gap (the domain) stand between "ready to demo to a friendly user" and "ready to post publicly."

### Where Synth actually sits in the Five-Phase model

The skill describes Internal → Alpha → Beta → Early Access → Full Launch as a deliberate progression, each phase validating before the next. Synth has effectively skipped straight from active development to attempting Phase 5 (Full Launch — "open self-serve signups, announce general availability") with none of the earlier phases' feedback loops:

- **No Phase 1 (Internal)** — no evidence of friendly users testing and reporting friction before this session's bug-hunting (which was me pressure-testing my own code, not real user feedback)
- **No Phase 2/3 (Alpha/Beta)** — no waitlist, no early-access list, no controlled external testers
- **Jumping to Phase 5** — "post it live for the world" is exactly Phase 5 language, attempted without the validation phases that catch exactly the kind of things Section 7 found (paywall timing, silent AI degradation) *before* a stranger hits them instead of after

**This isn't a reason to delay indefinitely** — plenty of good launches skip straight to a small, honest public beta. But worth being deliberate about it: if this goes out as "hey world, come use this," frame it as an honest beta/early-access moment rather than a polished GA launch, since the product itself hasn't had that intermediate validation yet. Costs nothing, sets the right expectations, and means early rough edges read as "beta" instead of "broken."

### ORB channel check — is there anywhere to send people?

Even once the product itself is ready, "the world" needs a way to hear about it. Current state, checked against the ORB framework:

| Channel type | Current state |
|---|---|
| **Owned** (email, blog, community) | None exist. No email capture on the landing page beyond the sign-in magic-link flow (which requires already deciding to sign up — not a top-of-funnel capture). No blog (ties to Section 1's finding — zero content pages exist at all). |
| **Rented** (social, PH, HN, Reddit) | No presence established yet, per Section 4's finding that zero third-party mentions currently exist anywhere for this product. |
| **Borrowed** (PR, influencers, guest content) | None identified or pursued yet. |

Every one of these is a "not started" rather than a "needs improvement" — which is fine at this stage, but means a Product Hunt / Hacker News launch attempt today would be launching into a total vacuum with nothing to fall back on and no owned audience to activate on launch day. Section 4's Reddit/Stack Overflow/PH recommendations are the actual starting point here, not optional extras.

### Launch checklist — audited against the skill's own list

**Pre-launch:**
- ✅ Landing page with a value proposition (tagline updated this session)
- ❌ Email capture / waitlist — doesn't exist as a distinct top-of-funnel mechanism
- ❌ Early access list — never built (see Five-Phase gap above)
- ❌ Owned channels — none (see ORB above)
- ❌ Rented channel presence — none
- ❌ Borrowed channel relationships — none
- ❌ Product Hunt listing — not prepared
- ❌ Launch assets (screenshots, demo video/GIFs) — none exist
- ⚠️ Onboarding flow — exists functionally (Lite → Normal → Premium), but Section 7 flagged real rough edges in it
- ❓ Analytics/tracking — not verified this session; worth confirming before driving any real traffic, since launch-day decisions are unmeasurable without it

**This list is almost entirely unchecked** — not a surprise given the product itself was the focus this session, but worth being explicit that "ready to post live" and "ready to launch" are two different bars, and only the first is close.

### Prioritized pre-launch punch list

1. **Fix Stripe test-mode keys** — nothing else matters if this isn't done first
2. **Fix the `datasets_user_filename_unique` bug** — a raw database error in an `alert()` is not acceptable for a stranger's first session
3. **Get a real custom domain** on the project
4. Everything already itemized in Sections 1–7 — this section doesn't replace those, it's the "are we ready" gate sitting on top of them
5. Decide deliberately: is this a quiet beta/early-access post, or a full GA-style launch? Given the gaps above, beta framing is the honest and lower-risk choice right now

### Checklist — launch readiness

- [ ] Switch Stripe to live keys (publishable + secret + webhook secret) — **blocking**
- [ ] Verify the `custom_checkout_payment_form_1` beta API is still current before going live on it
- [ ] Fix the `datasets_user_filename_unique` constraint bug (scope to `workspace_id`, not just `user_id` — diagnosed earlier this session)
- [ ] Secure and configure a real custom domain
- [ ] Confirm analytics/tracking is actually wired up before driving traffic
- [ ] Decide beta/early-access framing vs. full GA launch framing, and match the announcement copy to that choice
- [ ] Build at minimum one owned channel (email capture) before any Rented/Borrowed push, per the ORB framework's "funnel back to owned" principle
- [ ] Treat Sections 1, 4, 5, 6, and 7 of this document as the actual pre-launch backlog — this section is the readiness gate sitting on top of them, not a replacement
