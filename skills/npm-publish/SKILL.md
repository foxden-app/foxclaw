---
name: npm-publish
description: Publish npm packages safely, especially packages that require npm 2FA/web-auth confirmation. Use when Codex is asked to run npm publish, release a new package version, handle npm EOTP errors, generate an npm web-auth URL for the user, or verify an npm package version after publishing.
---

# NPM Publish

Use this skill to publish an npm package from a repo. Prefer the normal no-2FA publish path first. Fall back to npm web-auth only when npm explicitly prompts for it.

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
   git commit -m "<release message>"
   git push
   ```

## Publish Flow

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
- Never print npm tokens or `.npmrc` auth values.
