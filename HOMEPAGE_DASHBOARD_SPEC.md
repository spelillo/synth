# Homepage to dashboard restructure, plus account modal

Status: draft for build
Owner: Sean Pelillo
Date: 2026-09-22

## 1. Goal

Replace the gated signup landing page at `/` with a homepage that opens on the product itself: file upload and saved workspaces. Visitors should be able to start working right away instead of walking through a marketing page first. Sign-in and sign-up move into a modal that any part of the app can open, with email verification and password reset built in. The hero and marketing content moves to its own page and absorbs the current `/about` content, so there is one marketing page instead of two thin ones.

## 2. Purpose

The current `/` (`synth.html`, `#landing-view`) shows every visitor a side-by-side "create account | upload" panel before they can do anything, even though Lite Mode (no account) is fully supported. That layout contradicts the page's own `<meta name="description">` and the About page, which both say no sign-in is required to start.

Upload should be the first thing available on load. Hiding it behind a sign-in panel suggests an account is required when it isn't, and weakens the local, no-server pitch in `about.html`.

Signed-in users reach their saved work through `#dashboard-view`, which opens from a button inside the app shell (`openDashboard()` in `app.js:833`). Putting that list on the left half of the homepage means returning users see their workspaces as soon as the page loads.

The current auth UI is split between the landing page's two-column panel (`landing-panel-auth` / `landing-panel-upload`) and a header dropdown, and the landing version only works on first load. A modal can be opened from the dashboard, the marketing page, and any action that needs an account, such as saving work.

The hero page has parts worth keeping: the title, the Lite/Normal comparison under "More info", the three-step "How it works" band, and the footer links. It just shouldn't do the sign-in job anymore, and merging it with `/about` leaves one full marketing page.

## 3. Solution

### 3.1 Routes

| Route | Today | After this change |
|---|---|---|
| `/` | `synth.html`: gated hero, two-panel signup and upload, then the app shell | `synth.html`: dashboard homepage (upload and workspace cards), then the same app shell |
| `/welcome` (new) | none | The relocated hero page: title, mode comparison, How it works, About content, footer links |
| `/about` | Standalone About page | 301 redirect to `/welcome` (see 3.5) |

In `vercel.json`, add `{ "source": "/welcome", "destination": "/welcome.html" }` and change `/about` from a rewrite to a 301 redirect to `/welcome`.

The site stays static HTML with `app.js`, `auth.js`, and `state.js`. There is no new framework or build step.

### 3.2 New homepage (`/`, replacing `#landing-view` in `synth.html`)

The page splits into two columns at the vertical midline.

Left half, workspace access. This reuses `#dashboard-view` and `renderDashboard()` (`app.js:855`) for the workspace cards instead of rebuilding them.
- Signed out, the column shows one card explaining that saved workspaces appear here after sign-in, with a button that opens the account modal (3.4). It shouldn't show an empty grid, which would look broken.
- Signed in, the column shows the cards `renderDashboard()` already produces (open, rename, switch, delete). The separate full-screen `#dashboard-view` goes away. Calls to `openDashboard()` and `closeDashboard()` elsewhere in `app.js`, such as `app.js:2122`, are removed or pointed at this section.

Right half, top: file upload.
- A drag-and-drop or click-to-upload area fills the right column and takes roughly the top half of the viewport on desktop.
- It uses a translucent orange surface with a dashed border that firms up on hover and drag-over. The orange comes from the accent tokens already in `synth.html`'s `:root`.
- It calls the existing `uploadCSV(event)` handler (`synth.html:4417`) and the existing `#file-upload` input. Drag and drop needs new code, because the current input is a plain `<label for="file-upload">` with no drop target. The drop handler passes the dropped files to the same handler.
- Uploading doesn't require an account. An unauthenticated upload goes straight into the existing local SQLite flow, as Lite Mode does today.

Right half, bottom: flow cards.
- Three short cards under the upload area restate the existing How it works steps (`synth.html:4531-4546`) as Upload a file, Query with SQL or plain English, and View charts.
- Below them, a card asks visitors to sign in to save their work. With the old sign-in panel gone, this card is the main prompt to create an account. Its button opens the modal in sign-up mode.
- The cards are static apart from that button.

### 3.3 Relocated hero page (`/welcome`, new `welcome.html`)

Build it as a static page in the same style as `about.html`, using `marketing.css` and the shared `site-header` and `site-footer`. It has no dependency on the app shell, so it shouldn't load `synth.html`'s scripts and styles.

Top to bottom:
1. Hero title, reusing `synth.html:4422`: "Run SQL queries on your CSV files instantly."
2. The Lite vs. Normal comparison behind "More info" (`synth.html:4438-4468`), open by default. The toggle stays so visitors can collapse it.
3. The three-step How it works band (`synth.html:4529-4548`), unchanged.
4. The body of `about.html`: What Synth is, Local by default, SQL or plain English, Why it exists, Multi-table workspaces, and Contact. It skips `about.html`'s own title and subtitle because the page already has a hero.
5. The existing footer links to Guides, Terms of Service, and Privacy Policy. The About link is dropped because this page is the About page.

This page has no sign-up panel, upload button, or account-creation flow. Its actions are the navigation links and an "Open Synth" button that goes to `/`.

### 3.4 Account modal (sign in and sign up, top right)

A button at the top right of the homepage opens the modal. Signed out, it reads "Sign in". Signed in, it shows the account email and opens Settings.

The modal's value line is "Sign in to save files and sessions, use the AI tools, and keep the queries behind your charts." It appears as the modal's pitch, since this is the case for why a Lite Mode visitor should create an account.

The modal is a single column that switches between modes, replacing the old side-by-side layout:
- Sign in (default): email and password, a "Forgot password?" link, submit, and a link to sign up.
- Sign up: email and password, then submit, which leads to email verification.
- Email verification: a confirmation code field and a resend link, using the existing `landing-auth-confirm-step` pattern (`synth.html:4500-4514`) and its logic in `auth.js`.
- Forgot password: uses `openForgotPasswordFromLanding()` (`synth.html:4496`) and its `auth.js` counterpart.

Most of this work is moving the existing markup and handlers from the old `#landing-view` panel into a modal. The email and password fields, submit handlers, confirmation step, and forgot-password link already work (`synth.html:4472-4517`, `auth.js`). The modal needs to open from several places: the top-right button, the "sign in to save" card, and any future action that needs an account.

### 3.5 `/about`

`/welcome` absorbs `/about`'s content, so `/about` should 301 redirect to `/welcome`. Keeping both live would duplicate content for search engines and leave two copies of the same text to maintain. Update `sitemap.xml` to list `/welcome` instead of `/about`, and point every internal `href="/about"` at `/welcome`. That includes the footers in `synth.html`, `guides.html`, `terms.html`, and `privacy.html`; grep the repo for the rest.

### 3.6 Build order

1. Move the auth flow into a standalone modal first. Pull the sign-in, sign-up, confirmation, and forgot-password markup and scripts out of `#landing-view`, open the modal from a temporary trigger, and test the full flow (sign up, confirm code, sign in, forgot password) before changing the layout. If that works, the rest of the build shouldn't need changes to `auth.js`'s request logic.
2. Build `/welcome.html` on `marketing.css` with the hero, the comparison (open by default), How it works, the About body, and the footer. Confirm it renders without `app.js` or `auth.js`.
3. Rebuild `/` as the dashboard homepage: workspace cards on the left (signed-out prompt or signed-in cards), the upload area and flow cards on the right, and the modal trigger at the top right.
4. Connect the drop area to `uploadCSV` and confirm a signed-out upload still works.
5. Redirect `/about` to `/welcome`, and update `vercel.json`, `sitemap.xml`, and internal links.
6. Remove the old code: the two-panel `#landing-view` markup and CSS, the full-screen toggling in `openDashboard` and `closeDashboard`, and any unused `landing-panel-*` styles. Do this last, once everything above works, so nothing still in use gets deleted.

### 3.7 Acceptance criteria

- [ ] Signed out, `/` shows the orange upload area (top right), the flow cards with a sign-in prompt (bottom right), a workspace prompt (left), and a sign-in button (top right). Uploading doesn't require an account.
- [ ] Uploading a CSV while signed out opens the query and chat app shell in Lite Mode, as it does after the current gate.
- [ ] Signed in, `/` shows the user's workspace cards in the left column with the same data `renderDashboard()` shows today, and open, rename, switch, and delete all work.
- [ ] The top-right button opens the modal on Sign In, and a link switches to Sign Up.
- [ ] Sign up, the confirmation code, and a successful confirmation leave the user signed in, with the same emails and error states `auth.js` produces today.
- [ ] "Forgot password?" in the modal completes the existing reset flow.
- [ ] `/welcome` shows the hero title, the comparison already open, the three-step How it works band, the About content, and a footer with Guides, Terms, and Privacy links.
- [ ] `/about` returns a 301 to `/welcome`, and no page links to `/about`.
- [ ] `sitemap.xml` lists `/welcome` and not `/about`.

## 4. Decisions (resolved 2026-09-22)

- "New workspace": keep both entry points. The upload area and a "New workspace" button in the signed-in left column both open the file picker.
- Sign-in entry: the top-right header button opens the account modal. `/welcome` links to it with `/?auth=signin`, and the home footer's "About" link goes to `/welcome`.
- "AI tools" and "power chart builder": both are live features. The AI tools require an account; charting does not, and charts are not saved. The modal and the home's "save your work" card say an account saves the queries behind your charts.
