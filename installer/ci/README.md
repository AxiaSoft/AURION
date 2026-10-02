# Building the MSI on GitHub

`build-msi.yml` is a GitHub Actions workflow that produces a real installer on
a Windows runner and leaves it as a downloadable artifact. It runs the
project's own `installer\tools\build-msi.ps1`; nothing about the build is
reimplemented here.

## Why it lives in this folder

GitHub refuses a push that creates or changes anything under
`.github/workflows/` unless the pushing credential holds the `workflows`
permission, which the assistant's app token does not. So the file is kept
here, versioned and reviewable, and installed with one command.

## Turning it on

From a clone, once:

```bash
mkdir -p .github/workflows
cp installer/ci/build-msi.yml .github/workflows/build-msi.yml
git add .github/workflows/build-msi.yml
git commit -m "ci: build the MSI on GitHub's Windows runner"
git push
```

Or, without a clone: open the repository on github.com, press **Add file ->
Create new file**, name it `.github/workflows/build-msi.yml`, paste the
contents of `installer/ci/build-msi.yml`, and commit.

## Using it

**Actions -> Build MSI -> Run workflow**, pick the branch, and run. It also
runs by itself on every push that touches the installer, the desk, the engine
or the backend.

Two jobs:

| job | runner | what it proves |
|-----|--------|----------------|
| Tests | ubuntu | the seven desk suites, the five repository suites, and that every branding asset is the format its name claims |
| Installer | windows | that the desk window compiles and that a complete MSI can be produced |

When it finishes, the run page has two artifacts:

- **AURION-msi** - the installer itself, ready to download and run.
- **build-log** - the MSBuild binary log, kept whether the build worked or
  not. Open it with <https://msbuildlog.com> to find the exact failing task.

## What this fixes beyond convenience

The installer can only be built on Windows, so until now the only machine
that could say whether a C# change compiled was one laptop that also had to
run the whole build by hand. A compile error in the desk window therefore
only surfaced at the end of a long manual build - and a stale checkout looked
exactly like a fix that had not worked.

Running it here makes the answer public, repeatable and attached to the
commit that caused it.
