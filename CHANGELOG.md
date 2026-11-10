# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-10

First public release.

### Added

- **Explain this action** button under the DSH permission approval card, rendered
  by the plugin inside the composer chain alongside the official card.
- Explanation pipeline: host-side internal command that resolves the correlated
  `tool/call` from the session log, prompts the session's model with the tool
  name, raw arguments and the user's last message, and validates the returned
  JSON before rendering.
- Plain-language output contract: what the action does, what it touches, whether
  it changes anything, privacy risk, plus a risk level and a recommendation.
- Per-`callId` result cache on both the host and the client.
- Empty-reply recovery: lowest reasoning effort via `llm.prepareCall`, 2000-token
  output budget, `block-end` + `text-delta` text harvesting, one automatic retry.
- Fallback approval card and an error boundary, so a failure in the explanation
  UI never blocks the approval decision.

### Notes

- Explanations are generated in Simplified Chinese.
- Requires DSH `0.2.2-rc.1` or a compatible `0.2.x` host.
