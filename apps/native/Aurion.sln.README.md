# apps/native

Phase one of the native desk: the logic, with no UI in it.

```
dotnet test apps/native/Aurion.Core.Tests
```

`Aurion.Core` has no UI dependency and must not grow one. The window,
the chart and the glass come later and on top of this — the order is
deliberate, because everything in here can be proven by a test run and
none of the visual work can.

| piece | proven by |
|---|---|
| `Api/AurionApi.g.cs` | generated from `docs/api-surface.json`; `npm run test:apisurface` and `tests/native-contract.test.cjs` |
| `I18n/Lang.cs` | `LangTests` — the real `lang/*.json`, all three packs |
| `Money/*` | `FixtureTests` — the same `tests/fixtures/*.json` the engine and web desk answer to |

Regenerate the API client after any backend route change:

```
npm run api:surface   # re-read the routes out of the source
npm run native:api    # regenerate the C# client from the manifest
```
