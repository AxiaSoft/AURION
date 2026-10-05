# Enabling CI

`ci-workflow.yml` is the continuous-integration pipeline for this repository.
It is parked here rather than at `.github/workflows/ci.yml` because the token
that pushed it is not allowed to create workflow files — GitHub rejects the
push outright unless the app holds the `workflows` permission.

Move it into place yourself and it starts running on the next push:

```bash
mkdir -p .github/workflows
git mv .github/ci-workflow.yml .github/workflows/ci.yml
git commit -m "ci: enable the pipeline"
git push
```

## What it runs

| Job | What it checks |
|---|---|
| `desk` | Node 18 / 20 / 22 — `npm test` (syntax, unit, static guards, jsdom render), then boots the desk and hits `/api/health` |
| `engine` | Python 3.10 / 3.11 / 3.12 — `pytest engine/tests`, then boots the engine and hits `/health` |
| `keyserver` | `store/keyserver` tests, including the Ed25519 parity check that mints keys in Node and decodes them in Python (and back) |
| `translations` | `lang/en.json`, `fa.json` and `ar.json` must define exactly the same keys |

Python is capped at 3.12 on purpose: `engine/main.py` refuses to start on 3.13
and later, because `numpy==1.26.4` has no wheels for them.

All of it runs locally too:

```bash
npm test
pytest engine/tests -q
node scripts/check-lang.mjs
npm --prefix store/keyserver test
```
