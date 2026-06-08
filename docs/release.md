# FoxClaw Release Runbook

This file is for maintainers. User upgrades are driven by `/update` or `foxclaw update`, but those commands install `@foxden-app/foxclaw@latest` from the npm registry. Pushing a PR branch or a normal commit does not make installed nodes receive a new version.

## Release Rules

- npm `latest` is the source of truth for `/update`.
- The GitHub `Publish` workflow is triggered by `v*` tags and also supports manual dispatch; normal releases should use tags.
- The tag name must match `v<package.json version>`. For example, `package.json` version `0.5.10` must be released with `v0.5.10`.
- Versions already present on npm are not published again. Reinstalling the same version may report `0.5.10 -> 0.5.10` in Telegram; that means registry latest did not move.
- `CHANGELOG.md` must contain the target version entry. `/update` reads that entry from the installed package and shows it as the upgrade notes.

## Preflight

Check the worktree and remote state:

```bash
git status --short --branch
npm pkg get name version
npm view @foxden-app/foxclaw version
git tag --list 'v*' --sort=-v:refname | head
```

Confirm the target version and remote tag do not already exist:

```bash
npm view @foxden-app/foxclaw@0.5.10 version 2>/dev/null || true
git ls-remote --tags origin refs/tags/v0.5.10
```

Run the same local checks as the publish workflow:

```bash
npm run lint
npm run typecheck
npm test
npm pack --dry-run
git diff --check
```

`npm pack --dry-run` runs `prepack` and lists the package contents. Confirm `CHANGELOG.md` is included.

## Prepare The Version

1. Update `package.json` and `package-lock.json`.
2. Add a new top entry to `CHANGELOG.md` with both `### 中文` and `### English` sections.
3. Commit the release metadata:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "发布 0.5.10：short release summary"
```

## Push And Publish

This repository uses lightweight tags:

```bash
git tag v0.5.10
git push origin <branch>
git push origin v0.5.10
```

Watch the publish workflow:

```bash
gh run list --repo foxden-app/foxclaw --workflow Publish --limit 5
gh run watch <run-id> --repo foxden-app/foxclaw --exit-status
```

After success, verify npm and GitHub Releases:

```bash
npm view @foxden-app/foxclaw version
gh release view v0.5.10 --repo foxden-app/foxclaw --json tagName,name,url,publishedAt,isDraft,isPrerelease
```

## Verify `/update`

On a node still running the previous version, send `/update`. Expected:

```text
FoxClaw upgraded and restarted: 0.5.9 -> 0.5.10.

What changed:
- ...
```

If the node is already on the latest version, another `/update` may report:

```text
FoxClaw upgraded and restarted: 0.5.10 -> 0.5.10.
```

That means it reinstalled the current npm latest, not that a newer version was available.

## Failure Handling

- If the workflow fails during version validation, check that the tag and `package.json` version match.
- If npm says the version already exists, do not reuse that version; publish the next patch after fixing the metadata.
- If npm publish succeeds but GitHub Release creation fails, rerun the workflow or repair the release notes manually.
- Do not delete and republish npm versions. Prefer publishing a fixed patch release; use npm dist-tags for emergency latest rollback only when necessary.
