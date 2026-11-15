# Failure modes

The rows below are illustrative examples of the kind of failure this release method guards against. They are not a record of real incidents. Each guard is a `file::symbol` reference, and `test/registry.test.mjs` fails if the file or the symbol text does not exist, if a row has no guard, or if the ids are not sequential.

| ID | Failure | Cause | Guard |
|----|---------|-------|-------|
| F01 | Files are uploaded without comparing them with what is on the server | The release copies the whole build and never looks at the target | `release.mjs::buildPlan`, `test/release.test.mjs::classifies every file as NEW, CHANGED, IDENTICAL, DENIED or NOISE-ONLY` |
| F02 | A configuration file on the server is overwritten by the build's copy | A blind copy treats every build file as safe to upload | `release.mjs::DENIED`, `test/release.test.mjs::never writes or counts denied files` |
| F03 | A rebuild changes a timestamp or id on every page, so everything looks changed | Generated lines differ on every build | `release.mjs::onlyNoise`, `test/release.test.mjs::does not upload noise-only files` |
| F04 | The check passes because it only looked at a few files | The check samples instead of reading every uploaded file | `release.mjs::verify`, `test/release.test.mjs::verify reports a mismatch when a file is altered afterwards` |
| F05 | A rollback overwrites a file that was edited after the release | The rollback restores backups without checking the current bytes | `release.mjs::rollback`, `test/release.test.mjs::refuses rollback when a file changed after apply` |
| F06 | The release that runs is not the one that was reviewed | The build or the target changed between the review and the apply | `test/release.test.mjs::refuses a stale plan id`, `test/release.test.mjs::refuses when the target changed after the plan was made` |
| F07 | A not-found page served with a success status passes a status-code check | Known blind spot: a status code says nothing about the content served | smoke is not implemented; verify compares bytes (`release.mjs::verify`) |
| F08 | An ambiguous manifest uploads more or less than intended | An empty list, a repeated entry or an unknown file is read loosely | `release.mjs::readManifest`, `test/release.test.mjs::refuses an ambiguous manifest` |
