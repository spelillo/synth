PageSpeed Insights Report
Report Date: Sep 28, 2026, 8:19:08 AM
URL: https://vercel-nine-zeta-17.vercel.app/

Device Categories

Mobile
Desktop


Real User Experience
No Data Available

Performance Summary

Performance: 88
Accessibility: 94
Best Practices: 100
SEO: 100
Agentic Browsing: 2/3


Core Web Vitals & Metrics





























MetricValueFirst Contentful Paint (FCP)1.0 sLargest Contentful Paint (LCP)2.0 sTotal Blocking Time (TBT)100 msCumulative Layout Shift (CLS)0.048Speed Index (SI)1.1 s
Captured at Sep 28, 2026, 8:19 AM EDT
Environment: Emulated Desktop – Lighthouse 13.5.0
Session: Single‑page load

Screenshots
(Multiple screenshots captured — omitted for brevity.)

Insights & Diagnostics

Render‑Blocking Requests
Estimated Savings: 850 ms
These requests delay initial render and may impact LCP.
Notable Requests:

vercel.app (1st party) – 93.7 KiB, 1930 ms
/app.js – 36.3 KiB, 310 ms
/state.js – 1.3 KiB, 80 ms
/auth.js – 5.4 KiB, 230 ms
/charts.js – 17.9 KiB, 150 ms
/csv-parser.js – 3.0 KiB, 230 ms
/chat.js – 10.5 KiB, 150 ms
/json-parser.js – 3.8 KiB, 230 ms
/grid.js – 8.3 KiB, 80 ms
/storage-cookie.js – 1.8 KiB, 230 ms
/checkout.js – 5.4 KiB, 230 ms

Stripe Utility

/dahlia/stripe.js – 263.4 KiB, 760 ms

JSDelivr CDN

sql-wasm.js – 18.2 KiB, 310 ms
@supabase/supabase-js@2 – 55.6 KiB, 470 ms
regular/style.css – 12.9 KiB, 200 ms

Google Fonts

1.6 KiB, 200 ms


Image Delivery Improvements
Estimated Savings: 818 KiB
Large images causing slow LCP:

synth-cream-orangediscs.png (779.7 KiB, displayed 121×40)

Modern formats recommended (WebP, AVIF)
Over‑sized compared to display size


bi-icon.png (39.2 KiB, displayed 15×15)

Modern formats recommended
Over‑sized relative to display




Cache Lifetime Improvements
Estimated Savings: 281 KiB
Short cache TTLs detected (Stripe JS, JSDelivr).

Critical Request Chains
Max critical path latency: 979 ms
Example chain:

Initial navigation → storage-cookie.js → auth.js → checkout.js → grid.js → charts.js → chat.js → app.js → sql-wasm.wasm → Google Fonts → font files → CSS → Supabase → Stripe…


Preconnects
Page preconnected to:

https://fonts.googleapis.com
https://fonts.gstatic.com

No additional recommended preconnect origins.

Font Display Optimization
Estimated Savings: 20 ms
Consider: font-display: swap or optional.

Layout Shift Culprits
Missing explicit width/height on images:

synth-cream-orangediscs.png


JavaScript Improvements
Reduce unused JS
Estimated Savings: 265 KiB
Largest contributor: Stripe script.
Minify JS
Estimated Savings: 25 KiB

CSS Improvements
Minify CSS
Estimated Savings: 8 KiB
Reduce unused CSS
Estimated Savings: 30 KiB

Main Thread
Two long tasks detected (does not impact score directly).

Accessibility (Score: 94)
Failing: Low Contrast Text
Buttons:

“Choose a file”
“Create account”

Best Practice Issue

Document missing main landmark (<main>)


Best Practices (Score: 100)
CSP, COOP, clickjacking protection, Trusted Types all pass.

SEO (Score: 100)

Structured data valid
Recommended to run additional validators


Agentic Browsing (2/3)
LLMs.txt file does not follow recommendations:

Should be Markdown
Should contain at least one H1
No links detected


Resources & Links

Documentation
Web Performance Guides
Stack Overflow
Mailing list
Related content (DevTools, podcasts, case studies)



