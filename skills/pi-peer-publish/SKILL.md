---
name: pi-peer-publish
description: Prepare @cryptolibertus/pi-peer for npm publication safely. Use when the user asks to publish, release, npm publish, bump the package version, or verify/package/push an npm release for this pi-peer package. The final npm publish command is always left for the user to run manually.
---

# Pi peer publish

This skill prepares `@cryptolibertus/pi-peer` for npm publication from the repository root. It verifies, bumps, commits, tags, and pushes the release, then stops before the final `npm publish` so the user runs that command manually.

## Safety rules

- Never publish with uncommitted source changes unless the user explicitly asks to include them and they have been committed first.
- Never commit `.pi/`, local peer runtime state, npm debug logs, or generated tarballs.
- Always stop before `npm publish`. Never run the final publish command from the agent, even if the user says "publish". Show the exact `npm publish --access public` command for the user to run manually.
- If `npm whoami` fails, stop and ask the user to authenticate with `npm login` or configure an automation token outside the chat.
- For scoped packages, always publish with `--access public` unless `package.json` says otherwise.

## Workflow

1. Inspect release state:
   ```bash
   git status --short --branch
   git remote get-url origin
   git branch --show-current
   npm whoami
   npm view @cryptolibertus/pi-peer version --json
   node -p "require('./package.json').version"
   ```

2. Ensure local peer state will not be committed:
   ```bash
   grep -qxF '.pi/' .git/info/exclude 2>/dev/null || echo '.pi/' >> .git/info/exclude
   ```

3. Verify package quality and tarball contents:
   ```bash
   npm run check
   npm pack --dry-run
   ```

4. Choose the version bump:
   - Default to `patch` for small fixes and docs.
   - Use `minor` only for new user-facing capabilities.
   - Use `major` only for breaking changes, and ask the user first.

5. Bump, commit, and tag using npm so `package.json`, `package-lock.json` if present, and the git tag stay consistent:
   ```bash
   npm version patch
   ```

6. Push the release commit and tag:
   ```bash
   git push origin HEAD --follow-tags
   ```

7. Stop and hand the final publish command to the user. Do not execute it:
   ```bash
   npm publish --access public
   ```

8. After the user confirms they ran the publish command, verify the published package:
   ```bash
   npm view @cryptolibertus/pi-peer version
   npm view @cryptolibertus/pi-peer dist-tags --json
   ```

## Failure handling

- If `npm version` fails because the working tree is dirty, inspect `git status --short`; commit intended changes or revert accidental/generated files before retrying.
- If the tag already exists locally or remotely, compare the package version with `npm view`. Do not force-push tags. Pick the next valid version instead.
- If the user reports that `npm publish` says the version already exists, do not retry the same version. Verify with `npm view`, then bump to the next patch version if the user still wants to publish.
- If tests fail, stop and fix the failure before bumping or publishing.

## Final response

Report:

- Package name and prepared version
- Commit hash and tag pushed
- Verification commands with exit status
- Exact publish command left for the user
- npm package URL
- Any skipped step or blocker
