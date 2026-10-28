# CI that has to be installed by hand

`demo-market.yml` belongs at `.github/workflows/demo-market.yml`.

It is parked here because the automation account pushing to this
repository does not hold GitHub's `workflows` permission, so a push that
adds or edits a file under `.github/workflows/` is rejected outright.
The file is kept in version control rather than lost, and copied into
place by someone whose token can write workflows.

## Installing it

Either copy the file:

    mkdir -p .github/workflows
    cp docs/ci/demo-market.yml .github/workflows/demo-market.yml
    git add .github/workflows/demo-market.yml && git commit && git push

or paste its contents into GitHub's web editor, which always has the
permission (Actions -> New workflow -> set up a workflow yourself).

## What it does

Captures real market candles for the published demo and commits them to
`apps/web/demo/market.js`.

The demo is a static page: no engine, no desk, nothing that can reach a
price source. It cannot fetch one from the browser either, because Yahoo
sends no `Access-Control-Allow-Origin` and a call from `github.io` is
refused. The capture therefore runs on a runner, where CORS does not
apply.

Until the workflow is installed, the same thing can be done by hand from
a machine with internet access:

    npm run demo:market

The demo works either way. With no capture present it falls back to the
generated walk it has always used, and says so on the banner.
