/** Shared Browser guidance is bundled once by list_tools(category=browser). */
export const BROWSER_WORKFLOW_RULES = `### Browser workflow

Use Browser automation for JavaScript-rendered pages, interaction, or a login state already established in Joko's isolated Browser. Prefer a normal web fetch/search or an HTTP client for public static pages, feeds, documentation, and JSON APIs. The automated Browser cannot borrow cookies from the user's everyday system browser.

#### Observe, act, observe

1. Call \`status\` before substantial work and use \`doctor\` when the runtime looks unhealthy. Call \`tabs\` before \`open\`; reuse a matching tab and give important tabs stable labels.
2. Before clicking or typing, call \`snapshot\` for the same \`targetId\`. Prefer the newest snapshot \`ref\`; do not guess selectors for one-off interaction. Use \`interactive\`, \`compact\`, \`selector\`, \`frame\`, \`depth\`, and \`maxChars\` to keep observations focused.
3. Use \`act\` for atomic interaction. Supported request kinds are \`click\`, \`clickCoords\`, \`type\`, \`press\`, \`hover\`, \`drag\`, \`select\`, \`fill\`, \`resize\`, \`wait\`, \`evaluate\`, \`saveResource\`, and \`close\`. A navigation, submit, dialog, or major DOM update makes old refs stale; snapshot again before the next interaction.
4. Wait for a concrete load state, selector, URL, or disappearing text. Do not loop blindly. On a login wall, CAPTCHA, two-factor prompt, or human approval, stop and tell the user which Browser surface and tab needs attention.

#### Efficient extraction

- Start with \`siteguide\`. With a \`site\`, it returns that site's entry points and recipes; without one it lists the available site catalog. If a recipe fits, run \`recipe\` with its declared inputs.
- For API-backed pages, use \`requests\` with a narrow URL filter to inspect the bounded history of requests that have already happened. For a public GET endpoint, navigating directly to it and extracting \`body\` is usually simplest.
- \`responseBody\` is different: it arms a listener and waits for the **next** matching response, with a default 20-second timeout. It never reads response history. Arm it before the page action that triggers the XHR/fetch; a sequential tool caller generally should prefer direct GET navigation when possible.
- Use scoped \`snapshot\` to learn the real DOM. Use \`extract\` when exact fields or clean JSON are needed. In \`extract.fields\`, a string is a CSS selector whose text is returned; use \`{selector, attr}\` for an attribute and \`{selector, type:"href"}\` for a resolved link. Lists use \`from\` plus \`multiple\` and a bounded \`limit\`.
- Use \`screenshot\` only for visual evidence. Use \`urls:true\` when actual link/resource URLs matter and \`labels:true\` only when spatial labels help.

#### Browser surfaces and login state

The action set is the same for embedded and external presentation. Capability data from \`status\` is authoritative; do not branch on implementation IDs. Semantic \`query\` lookup and managed \`saveResource\` are available only when the active backend advertises them. Otherwise use snapshot refs/selectors and artifact-safe transfer operations.

The embedded and external profiles are isolated from each other and from the user's normal browser. The external managed profile is shown as Joko. A login performed in one managed profile persists there, but not in the other. Do not pass or invent a profile to reach a user's normal Chrome/Safari session. If login is required, focus the relevant tab, ask the user to log in on that exact Browser surface, then snapshot again. OAuth popups may become a separate tab; after authorization, return to and refresh the original tab if it remains waiting.

#### Failure recovery

- If a ref is stale, snapshot the same target and retry once with a new ref.
- If the page becomes a login, verification, or error screen, stop and report it instead of repeating actions.
- If Browser health is unavailable, tell the user to open Settings → Automation and recover the Browser backend. A runtime recovery fences the old generation; never reuse old tab IDs, refs, leases, or results.
- Only HTTP(S) navigation is valid. Never place credentials in URLs, logs, recipes, selectors, diagnostics, or returned artifacts.

#### Action map

\`doctor/status/start/stop\` manage health and lifecycle. \`profiles\` reports isolated profiles, not site login status. \`tabs/open/focus/close\` manage tabs. \`snapshot/screenshot/navigate\` observe and move. \`console/requests/responseBody\` provide bounded diagnostics. \`pdf/upload/dialog\` cover document export, artifact-safe upload, and native dialogs. \`act\` performs the 13 atomic kinds. \`extract\` returns structured DOM data. \`recipe/siteguide/saveRecipe\` discover, execute, and persist reusable site knowledge.

\`wait\`, \`evaluate\`, and \`saveResource\` are not top-level actions; they are \`act.request.kind\` values. Recipe steps may use the recipe DSL's \`wait\` and \`evaluate\`, but a recipe may not use \`saveResource\`.
`;

export const BROWSER_RECIPE_AUTHOR_RULES = `### Browser recipe authoring

A recipe is declarative site knowledge, not executable host code. Use it for a flow worth repeating, then persist it with \`saveRecipe\`. User recipes may shadow a built-in recipe by ID; removing the user layer reveals the built-in version again.

#### Reconnaissance to persistence

1. Call \`siteguide\` for the host. If no recipe fits, navigate to the real page, take a scoped snapshot, and inspect narrowly filtered requests.
2. Prefer a stable public JSON/XML endpoint when one exists. Put changing query terms, page numbers, IDs, and cursors in declared inputs and interpolate them in the URL.
3. Record authentication expectations in the site guide. Login is performed by the user in the persistent managed Browser; recipes may probe login state with optional steps but must never contain credentials.
4. Confirm every DOM selector with a scoped snapshot. Use \`extract\` for fields: strings select text, \`{selector,attr}\` selects an attribute, and \`{selector,type:"href"}\` resolves a link. Use \`from\` and \`multiple\` for records.
5. Recipe interaction steps use stable CSS selectors rather than snapshot refs, because refs are generation- and observation-scoped. A \`type\` step may set \`submit:true\`.
6. Run the saved draft immediately with \`recipe\`, verify its output and failure step, then persist the corrected draft with \`saveRecipe\` and an optional site-guide draft.

#### API strategy

For a public GET API, navigate to the endpoint and extract \`body\`. For a same-origin API that needs the managed profile's cookies, navigate to the site's origin and use a bounded \`evaluate\` function that calls a relative URL with included credentials. The function must return JSON-safe data. Never read cookies/local storage directly or return credential material. \`responseBody\` waits for a future matching response and is not a historical response cache.

#### Draft shape

\`recipeDraft\` contains \`id\`, optional \`match\` and \`description\`, declared \`inputs\`, a non-empty \`steps\` array, and optional \`output\`. Step actions are \`navigate\`, \`click\`, \`type\`, \`select\`, \`wait\`, \`extract\`, \`evaluate\`, \`requests\`, and \`responseBody\`. A step may store its result with \`as\`; a later step or \`output\` may reference it as \`{{name}}\`.

Every input referenced by interpolation must be declared required. Use \`{{value|url}}\` inside URL query components and \`{{value|js}}\` inside an evaluate function string. Exact \`output:"{{value}}"\` returns the structured value rather than a string. Non-optional step failure stops the recipe and reports \`failedStep\`; return to a scoped snapshot, repair the selector/request, rerun, and save the corrected version. Keep pagination explicit as an input and run one bounded page at a time.
`;
