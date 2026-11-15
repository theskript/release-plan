# release-plan

A small demonstration of a careful release method for pushing a built folder onto a target folder. It ships with sample data (a tiny cafe website), uses local folders only, has no network code and no dependencies, and is not used on a real server.

## The path of one release

1. A build exists in one folder; the target is another folder.
2. `plan` compares every candidate file with the target and classifies it as NEW, CHANGED, IDENTICAL, DENIED or NOISE-ONLY. It changes nothing except saving the plan under `.release/plans/` in the target, and prints the plan id.
3. A person reviews the plan.
4. `apply --plan <id>` recomputes the plan and refuses unless its id equals the reviewed one, so the build or the target cannot drift after review. It also refuses a target that is cherry-pick only unless a manifest is given.
5. Every file that will be overwritten is copied to `.release/backups/<id>/`, and each copy is checked against the original.
6. NEW and CHANGED files are written. DENIED and NOISE-ONLY files are never written.
7. Every written file is read back from the target and compared with the build; the result is confirmed, mismatch or missing per file.
8. One line is appended to `.release/ledger.md`.
9. If needed, `rollback --plan <id>` restores the backups, but only if no restored file has changed since the apply.

## Usage

Run the demo on a copy, because `apply` changes the target:

```sh
cp -R sample /tmp/demo
node release.mjs /tmp/demo/build /tmp/demo/server plan --config /tmp/demo/release.config.json
node release.mjs /tmp/demo/build /tmp/demo/server apply --plan <id> --config /tmp/demo/release.config.json
node release.mjs /tmp/demo/build /tmp/demo/server verify --plan <id>
node release.mjs /tmp/demo/build /tmp/demo/server rollback --plan <id> --delete-new
node release.mjs /tmp/demo/build /tmp/demo/server log
```

Add `--manifest files.json` (a JSON list of paths, or `{ "files": [...] }`) to limit a release to the listed files. Exit codes: 0 ok, 1 error or refusal, 2 verification failed.

`release.config.json` holds `deny` (glob-like paths that are never uploaded; a pattern without a slash matches the file name at any depth), `noise` (regular expressions for text that differs on every rebuild) and `cherryPickOnly` (target folder names that refuse a full apply).

## Tests

```sh
npm test
```

Node 20.11 or newer, no install step. `docs/FAILURE-MODES.md` is an illustrative register; `test/registry.test.mjs` checks that every guard it names exists.

## Decisions

- The plan id covers the target's checksums as well as the build's. Reason: a changed target must invalidate a reviewed plan. Cost: an unrelated edit to a file in the upload set forces a new review.
- Noise is removed by pattern, not by dropping whole lines. Reason: a noisy line cannot hide a real change next to it. Cost: a pattern that is too broad hides real changes.
- Verification compares against the checksum recorded in the plan. Reason: it proves the reviewed bytes arrived. Cost: a build edited after the plan reports mismatch.
- State lives in the target under `.release/`. Reason: the backups and ledger travel with what they describe. Cost: the target holds files that are not content (they are skipped when planning).
- The ledger is a plain append-only Markdown file. Reason: readable with any tool. Cost: the tool never rewrites it, but nothing stops a person from editing it.
- The record of an apply is written after the files are written. Reason: rollback only trusts what was actually applied. Cost: an interrupted apply leaves backups but no record, so the tool cannot roll it back.

## Limits

- Local folders only; there is no network transfer.
- No concurrency control: two releases at once are not detected.
- A checksum proves bytes, not behaviour.
- The register test proves a guard exists, not that it works.

## Licence

MIT, see `LICENSE`.
