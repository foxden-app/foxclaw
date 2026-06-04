---
name: npm-publish
description: Publish npm packages safely, especially packages that require npm 2FA/web-auth confirmation. Use when Codex is asked to run npm publish, release a new package version, handle npm EOTP errors, generate an npm web-auth URL for the user, or verify an npm package version after publishing.
---

# NPM Publish

Use this skill to publish an npm package from a repo. Prefer CI trusted publishing when the repository has a publish workflow. Prefer the normal no-2FA publish path first only when CI publishing is not available. Fall back to npm web-auth only when npm explicitly prompts for it.

If the user asks to release, publish, "收尾", "push publish", or otherwise finish a completed package change, proceed through verification, commit, push, publish, and post-publish verification without asking for a second confirmation. Pause only for real blockers: missing credentials, failed checks, unrelated changes that would be staged, merge conflicts, an already-published target version that needs a version choice, or npm/GitHub web-auth that requires the user to click/confirm an external page.

Before publishing, honor any project-specific release documentation gate. For FoxClaw releases, verify design documentation, Chinese and English user manuals, `@BotFather` operation steps when Telegram setup changes, and external-facing README/CHANGELOG/release wording are updated or explicitly marked not applicable.

## Release Checklist

1. Sync first when the user asks for it:
   ```bash
   git pull
   ```

2. Confirm the package state:
   ```bash
   git status --short --branch
   npm whoami
   npm view <package-name> version
   ```

3. If the package version is already published, bump it before publishing:
   ```bash
   npm version patch --no-git-tag-version
   ```

4. Run the repo's normal verification before publishing. Prefer the package scripts that exist:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm pack --dry-run
   ```

5. Commit and push source changes before `npm publish` when the user asked to push or when this is a normal release:
   ```bash
   git add <changed-files>
   git commit -m "<Chinese | English release message>"
   git push
   ```

## Publish Flow

### GitHub Actions Trusted Publishing

Use this path when the repo has `.github/workflows/publish.yml` and npmjs.com has a trusted publisher configured for the package.

1. Verify the package version is not already published:
   ```bash
   npm view <package-name> version
   ```

2. If needed, bump the package version and commit it before tagging:
   ```bash
   npm version patch --no-git-tag-version
   git add package.json package-lock.json
   git commit -m "<Chinese | English release message when appropriate>"
   git push origin <branch>
   ```

3. Publish by pushing a matching version tag:
   ```bash
   git tag v<package-version>
   git push origin v<package-version>
   ```

4. Watch the GitHub Actions `Publish` workflow. It must run lint, typecheck, tests, `npm pack --dry-run`, then `npm publish --access public` through trusted publishing.

5. Verify the registry after the workflow succeeds:
   ```bash
   npm view <package-name> version
   ```

If the workflow provides `workflow_dispatch` as a recovery path, dispatch it only from an existing release tag whose version matches `package.json`. Do not dispatch publishing from a branch containing an unpublished version unless the workflow explicitly resolves and validates a release tag.

Do not store or print npm tokens when trusted publishing is available. If trusted publishing is not configured on npmjs.com, the workflow can use a GitHub Actions secret named `NPM_TOKEN` as a temporary fallback. Store only automation/bypass-2FA tokens there, never paste tokens in chat or commit them.

### Manual Publish

1. Start publish in a TTY and disable local browser opening. This works both when npm publishes directly and when it asks for web auth:
   ```bash
   BROWSER=true npm publish
   ```

2. If npm publishes directly, it should finish with:
   ```text
   + <package-name>@<version>
   ```
   Then verify:
   ```bash
   npm view <package-name> version
   git status --short --branch
   ```

3. If npm instead prints a web-auth prompt, use the fallback flow below.

## Web Auth Fallback

Use this only when npm prints:
```text
Authenticate your account at:
https://www.npmjs.com/auth/cli/<auth-id>
Press ENTER to open in the browser...
```

1. Send the URL to the user as a bare URL, not inside backticks or a code block. Bare URLs are easier to tap.

2. Do not press Enter immediately. Wait until the user says they clicked/confirmed the npm page.

3. After the user confirms, send Enter to the still-running TTY process. npm should retrieve the temporary token and finish:
   ```text
   + <package-name>@<version>
   ```

4. Verify the published version:
   ```bash
   npm view <package-name> version
   git status --short --branch
   ```

## Failure Modes

- If `npm publish` is run without a TTY, npm may print an `EOTP` error with the auth URL redacted as `***`. Stop that attempt and rerun with `BROWSER=true npm publish` in a TTY.
- If `xdg-open` fails because the environment has no browser, rerun with `BROWSER=true npm publish`.
- If the auth link expires or the publish process exits, rerun `BROWSER=true npm publish` to generate a new link.
- If the user provides a classic authenticator OTP instead of using the web link, publish can be retried with `npm publish --otp <code>`, but prefer web auth when the user asks for a clickable confirmation link.
- If a GitHub Actions release fails before the `npm publish` step, such as during checkout or action download authentication, do not diagnose it as a trusted publishing rejection. Inspect the failed step and GitHub Actions status first.
- Never print npm tokens or `.npmrc` auth values.
