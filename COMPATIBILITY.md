# Compatibility policy

`dsh-viztools` integrates with pre-stable DSH APIs. Compatibility is therefore explicit rather than assumed.

## Internal and OTX deployments

- Every plugin release pins its `@deepseek-ai/dsh-*` peer dependencies to the exact DSH release it was verified against.
- The OTX profile pins both DSH and `dsh-viztools`; upgrades are reviewed together.
- A peer range is widened only after the full test suite and disposable-profile activation tests pass against every release in that range.
- DSH version exemptions are not part of normal deployment. They are temporary diagnostic tools and require the normal DSH risk acknowledgement.

## Public releases

- Publish one plugin patch release for each newly supported DSH pre-release when API changes require it.
- Release notes state the exact verified DSH versions.
- Compatibility CI will install and activate each exported Cordis entry against every supported DSH version before a peer range is widened.
- After DSH APIs used by this package become stable, bounded semver ranges may replace exact pins.

## Current matrix

| dsh-viztools | DSH | Status |
|---|---|---|
| 0.1.x | 0.2.0-rc.2 | Supported and tested |

The package's Cordis peer (`@deepseek-ai/cordis`) remains on the compatible `~4.0.4` range because it is independently versioned and already uses stable range semantics.
