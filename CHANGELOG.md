# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-06

First release.

### Added

- "Rename with AI" row in the session `…` menu (`sidebar.workspaces.session.menu.item`,
  `order: 250`) and a matching chip in the session header
  (`conversation.session.header.actions`, `order: -8`).
- One on-demand auxiliary model call per click, written through
  `sessionTitle.rename()` — the same path the official rename menu uses — so the
  sidebar title updates and the title is pinned against automatic titling.
- Prefix-cache reuse: the request is built from `requestHeader()` tools plus
  `deriveMessages()` history, with the main request's `reasoningEffort` and
  `temperature` inherited verbatim, so the provider's prompt cache serves the long
  part and only the trailing instruction is billed at full price.
- Graceful degradation: when that prefix cannot be reproduced (no logged request,
  no assistant tail, no route) the call falls back to a clipped self-contained
  tail and reports `mode: "tail"`.
- Toasts for both success and failure, with the failure reason mapped from the
  Host's error code (timeout, nothing to summarize, unavailable).
- Owner-only endpoint admission through `ctx.connection.admit`.
- Host tests (`node --test`) covering the route, prefix reuse, the tail fallback,
  admission, and the title parser.
