# CAOS task taxonomy — implementation plan

## Goal

Let a user choose a task first, then choose a model that is known to support that task, without changing existing routing behavior or hiding manual choices.

## Taxonomy

Task tags are multi-valued and describe a model's *primary verified use*, not every task it might sometimes perform:

- `chat`: general text conversation and instruction following
- `writing`: writing, rewriting, summarization
- `coding`: code generation/debugging; distinguish general capability from a coding-specialized model in metadata
- `reasoning`: multi-step reasoning and mathematics
- `image-input`: accepts images as input for analysis
- `image-generation`: generates or edits images
- `audio-input`: accepts audio input
- `audio-generation`: generates speech/audio
- `transcription`: speech-to-text
- `video-generation`: generates video
- `video-input`: accepts video input
- `web-search`: searches the web / returns grounded web results
- `embeddings`: creates vector embeddings
- `decision`: lightweight routing/classification decisions

Input and output capabilities must never be conflated (for example, image-input is not image-generation).

## Evidence and trust

- Catalog metadata is accepted only inside the existing signed Ed25519 catalog; never weaken signature checks.
- Tags are optional for backwards compatibility. Missing tags mean “not classified”, not “unsupported”.
- Do not infer verified tags solely from a model name. Maintain source/evidence and verification state in the catalog authoring process.
- Distinguish verified provider/model capabilities from inferred suggestions and from runtime availability. A model may be capable but unavailable because no valid API key/quota exists.
- Never label a model “free” without an explicit, current quota/access basis. Show “API key required”, “free tier”, “local”, or “unknown” only when grounded in provider information.
- A model can have multiple tags. User-created/custom models remain usable even when they have no tags.

## Compatibility and persistence

- Add the metadata additively; old catalog documents remain valid.
- Store tags separately from existing display names/ranks/limits where practical, or add a nullable JSON field with a guarded migration. Preserve local overrides and tombstones.
- A sync failure, malformed payload, unknown tag, or invalid signature must leave the last applied catalog untouched.
- Keep the existing manual model selector and auto-routing options. Task filters narrow the visible list only; they must not silently rewrite fallback chains.
- Media models, search engines, transcription, embeddings, and decision models must stay in their current modality-specific registries.

## UI sequence

1. Add an optional task filter to the existing selector and capability details, with “All models” as the default.
2. Make the task selector and recommendation logic explain why a model matches; preserve direct/manual selection.
3. Verify data quality and usability before the final CAOS AI visual redesign.
4. In the final UI phase, build a distinct futuristic CAOS AI chat workspace rather than merely reskinning the upstream interface.

## Acceptance tests

- Old catalogs without task metadata still sync.
- Known valid tags sync and persist across subsequent catalog refreshes.
- Unknown tags are rejected or ignored safely according to a documented policy, never interpreted as capabilities.
- Unsigned/tampered catalog still fails closed.
- Local model edits, user-created models, tombstones, fallback chains and profiles survive sync.
- Task filtering is additive, multi-tag models can appear in multiple filters, and manual/automatic routing remains unchanged.
- Image input and image generation, audio input and speech generation, and transcription remain distinct.


## Capability-boundary validation (staged)

These checks are intentionally separate because the fields describe different facts:

1. **Signed catalog → database:** `supportsTools` is persisted as a declared capability independently of `taskTags`. A `coding` tag must not imply tool calling, and `supportsTools: true` must not imply that a provider key or quota is available.
2. **Database → API:** `/api/fallback` returns the boolean `supportsTools` and the verified task tags as separate fields. This is a serialization contract, not a runtime provider compatibility guarantee.
3. **Provider adapter → request:** a later integration test must exercise a tool-call request against each adapter family that advertises tool support. A model/catalog flag alone is insufficient evidence that an adapter translates and returns tool calls correctly.
4. **Runtime availability:** API key health, permissions, rate limits, and quota remain runtime state. They must not be encoded as task tags or inferred from `supportsTools`.
5. **Modality registries:** task-filter UI for image/audio generation, transcription, video, search, embeddings, and decision models must read their existing dedicated registries. Do not merge those records into the chat fallback list merely to populate a selector.

### Rollout gates

- **Stage A — metadata/API boundary:** signed-catalog persistence and `/api/fallback` serialization tests pass; existing signature and legacy-catalog tests remain green.
- **Stage B — adapter compatibility:** add targeted mocked request/response tests for tool-call translation per adapter family. Do not advertise support for an adapter family until its tests pass.
- **Stage C — modality filters:** add filters to the corresponding screens using their own registries, retain “All” as the default, and keep unclassified/custom entries visible in the unfiltered view.
- **Stage D — data quality:** audit catalog rows against explicit provider/model documentation or repeatable tests. Missing evidence stays unclassified; do not infer support from names.

No stage may change fallback routing or trigger paid provider usage without explicit authorization.
