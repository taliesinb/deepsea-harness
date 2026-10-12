---
description: "Model selection for the Web GUI: the /model popup and the composer model seat over one per-session provider-grouped directory; for users and maintainers of model routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

## Summary

The Web GUI lets users switch the model and reasoning effort for an existing session through either the `/model` popup or the composer's model control. Both surfaces present the same provider-grouped choices, and the selected model determines the available effort names and default. A complete selection applies to the next request; a running step keeps the model and effort it started with. If the selected model is unavailable, the composer stays disabled until the user selects an available model or that exact model becomes available again.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

DeepSeek account and API-key routes appear as separate provider groups, each exposing the same configured model catalog.

The unselected model label uses the same regular weight as an available model name and retains the saved reasoning effort caption for existing and new sessions; effort editing requires an available model. Clicking the unselected trigger opens the model list directly; Escape closes it.

Mount this plugin alongside `ui-conversation` and the commands package; the composer then shows the model seat next to the pending indicator, and `/model` opens the same directory as a popup. While the seat's menu is open, `↑`/`↓` move focus through root and effort rows, or move the model-list highlight without leaving search. Enter and Tab settle the highlighted model or focused row; Escape and `Shift+Tab` leave a drilled pane first and otherwise close back to the trigger. Drilling focuses model search when shown, otherwise the current model or effort row, and going back lands on the cell that opened the pane left. The composer shows the catalog name while the selected model is available, and its saved `provider/model` ID when the model or provider is removed, including account sign-out. The stored provider, model, and reasoning effort remain unchanged.

Mouse selection uses native browser clicks, including their cancellation behavior; a press alone never selects. Opening the root menu focuses its trigger, and clicking the trigger again closes the menu and returns focus there. Root rows and the search-clear button show the same fill for keyboard focus and hover, without a native outline. Selecting a model or effort returns focus to the trigger without a focus ring; leaving the trigger or reopening the menu restores its normal focus indication. While a selection from either entry is pending, focus stays on the trigger, the trigger shows a spinner in place of its chevron, and each row whose value the selection carries shows one in place of its check; a rejected selection leaves the menu open. Tab returns to model search with the current model highlighted when search is shown, otherwise to the current row.

### Model and effort

The button's model menu shows search only when its full catalog contains more than four models; smaller catalogs focus the current model or first row and support keyboard navigation directly. The `/model` command always keeps its search field. Both search fields match model names case-insensitively, including nonconsecutive characters in order; leading and trailing spaces are ignored. Within each provider, prefix matches come first, followed by alignment score and then catalog order. Empty groups are hidden. Empty catalogs and queries without matches are announced through a status region. Search keeps focus while arrow keys cycle the highlighted result across provider groups; Enter or Tab selects it. Left and right arrows keep their native caret behavior. Opening highlights the current model or the first available row, and editing the query resets the highlight to the first result. Reopening the model pane clears the query.

Under the search field, the composer menu shows a filter bar of glyph toggles. First the access kinds (a shield for **Plans**, a code frame for **API keys**, a fork for **OpenRouter**, a laptop for **Local**), offered only when the catalog has more than one kind; they act as radio buttons: none pressed shows every route, a pressed kind shows only its routes, and pressing it again shows all. Then **Images**, **Reasoning**, **Tools** and **Free**, each offered only while it splits the catalog (some models have the capability and some do not, from the catalog's per-model `capabilities`), and **Older models**. A pressed capability keeps only models with it, several pressed keep models with all of them, and search ranks what remains. Each toggle names itself in a tooltip at once, on hover or focus. A model is older when another model of the same route has the same name apart from a higher version number (`Claude Opus 4.5` beside `Claude Opus 5.5`), or is a dated snapshot of an undated model; older models are hidden until **Older models** is pressed, except the current model. Filters last while the composer stays mounted; a catalog small enough to show without search shows every model and no filter bar.

Model and reasoning-effort names use weight 400 (regular) in the composer menu, including the selected item. The search field follows the command popup's compact treatment with transparent background and border in both palettes, with no leading icon and a caption-tone placeholder. The clear button appears for a nonempty query and restores the full list with focus in the search field.

Both entries section the menu by provider and access kind, read from the catalog's route metadata rather than from ids or names: a route whose `auth` is `subscription` is a plan, `auth: local` a server on this machine, a route whose catalog provider is `openrouter` OpenRouter, and every other keyed route an API key. Sections of one provider sit together, plan first, then API key, then OpenRouter (`Anthropic Plan`, `Anthropic`, OpenRouter's `Anthropic`; providers match by name, a name that extends another joining it). DeepSeek Account and DeepSeek lead, other providers keep their catalog order, servers on this machine follow, then the vendors only OpenRouter offers, alphabetically, then OpenRouter models without a vendor. An OpenRouter route is split by upstream vendor: the vendor slug of each model id (`anthropic/…`), titled by the `Vendor: ` prefix of its models' names, which the rows then drop; when two OpenRouter routes offer one vendor, its heading names the route too. In the composer menu each section's heading carries its kind's glyph (a shield for a plan, a code frame for an API key, a fork for OpenRouter, a laptop for a local server); the same glyph leads the current model on the trigger and in the Model cell. Both use the shared, asynchronously observed sticky headings from [ui-primitives](../ui-primitives/README.md#understand-the-implementation): transparent at rest, with the theme's 94%-opaque fill only while pinned, and `md` corners outside macOS Desktop. The composer menu shows model and effort names only. Navigation chevrons use `--dsw-alias-menu-icon`. The `/model` popup shows each section's heading as text (an OpenRouter vendor followed by the route's name) and model names as rows, without repeating the provider on each row or showing catalog descriptions. Its search placeholder, no-match text, and empty-catalog text use the same localized labels as the composer model menu. The popup applies the selected model's default effort; the composer can then choose any advertised effort. An adapter without reasoning metadata leaves the Effort row absent; there is no arbitrary effort input.

The composer replaces the model and effort text with the Models icon when the expanded controls cannot share one line, and restores the text when space permits. The full selection remains available in the trigger's accessible name, tooltip, and menu.

### Unroutable sessions

Catalog availability does not block sending with a saved selection; request execution reports missing credentials or unavailable models. Refreshes and refresh failures retain the last displayed selection and groups. A Host reset clears that display. Sign-out hides the account provider from the picker while preserving the saved provider/model ID and reasoning effort. Signing in restores the catalog name when that model is available again. Existing session logs remain unchanged.

### Selection failures

When another writer owns the Session, model-selection failures tell the user to quit other running DSH instances and retry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Menus use the shared `MenuSurface` material, including the macOS backing for background blur; custom content follows the [menu rules](../../../docs/web-styling.md#component-rules).

<details>
<summary>Implementation internals — click to expand</summary>

The composer `ModelSelect` and `/model` option builder share [provider ordering](src/client/provider-order.ts), while both searches use `rankByName` within each provider. Route kinds, capability filters and older-model lines live in [route-sections.ts](src/client/route-sections.ts); the route glyphs are `RouteIcon` in `ModelSelect.tsx`, one line per kind, because the DeepSea billing plugin draws the same plan, OpenRouter and API glyphs and its tests compare them line by line. Kind headings are plain rows between the provider `MenuGroup`s, so the sticky observer still sees the groups as direct children of the list. The command supplies optional groups and `searchMode: 'fuzzy-label'` through the [popupSelect API](../ui-commands/README.md#use-this-package); both entries use `MenuGroup` and rebuild its sticky observer when the rendered groups change. The command popup fills the composer overlay, while the button retains its compact menu.

Two entries over ONE per-session directory owned by `ModelDirectoryResolver` (`ctx.modelDirectories`): the `/model` popupSelect contribution (registered through `ctx.commandUi`) and the composer's named `conversation.input.model` seat both load the session's available directory through `session.models` and submit through `session.selectModel` via the same `ModelDirectory` instance, so a switch made in either entry is what the other shows next. Directory loads and selections share a generation counter so an older response never overwrites a newer one. The directory publishes the latest submitted selection as `pending` until it settles or a connection reset invalidates it; a connection reset drops every resident projection and repulls the Host-restored selection before display. Directories are per-session, resolved lazily, and disposed with the session scope; addressed subagent sessions expose neither entry. Every resident directory refetches directly on forwarded `llm/adapters-updated`, `settings/document-updated`, and credential update events.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the model surface is not enough. They move from the browser surfaces to the command popup shell and the selection contract.

- [ui-commands](../ui-commands/README.md) — the popupSelect shell the `/model` contribution registers into.
- [ui-conversation](../ui-conversation/README.md) — declares the composer's `conversation.input.model` seat.
- [dsh-agent-default-model](../../core/agent-default-model/README.md) — the default-model service for sessions that never choose.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `session.selectModel` selection both entries submit: the Host snapshots the complete `ModelSelection` at the next prompt-assembly boundary and owns the model-visible effect, while a running step keeps its assembled selection.

#### KV Cache effect

Switching the route can reduce or invalidate provider-side cache reuse for subsequent requests; the prompt prefix itself is untouched.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current model surface. They are current package constraints, not a general model-router comparison or a task backlog.

- **No create-time or addressed-subagent selection** — both entries require an existing ordinary session's Agent; there is no draft-phase model choice to fold into session creation, and subagent continuation deliberately exposes no independent model-selection contract.
- **Directory names are presentation-only** — selection and persistence use provider/model/effort ids; a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row until reload.
- **No arbitrary effort input** — the composer offers only the exact model's adapter-advertised levels; an adapter without reasoning metadata leaves the Effort row absent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
