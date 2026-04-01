# Release & Publishing Guide

## Quick Start: Publishing a New Version

### Option 1: Automated Release (Recommended)

1. Go to: https://github.com/zonlabs/mcp-ts/actions
2. Click **"Release and Publish"** workflow in the left sidebar
3. Click **"Run workflow"** button
4. Select version bump type:
   - **patch** (1.3.7 → 1.3.8) - Bug fixes, small improvements
   - **minor** (1.3.7 → 1.4.0) - New features, backward compatible
   - **major** (1.3.7 → 2.0.0) - Breaking changes
5. Check "Is this a prerelease?" if releasing alpha/beta
6. Click **"Run workflow"**
7. Done! The workflow will:
   - ✅ Bump version in package.json
   - ✅ Create git commit with version
   - ✅ Create git tag (v1.3.8, etc.)
   - ✅ Publish to npm
   - ✅ Create GitHub Release

### Option 2: Manual Release

If you prefer more control, use GitHub's manual release interface:

1. Go to: https://github.com/zonlabs/mcp-ts/releases/new
2. Create release with:
   - **Tag:** v1.3.8 (must match package.json version)
   - **Title:** Release v1.3.8
   - **Description:** Change notes
3. Click "Publish release"
4. The npm-publish workflow will automatically publish to npm

## Semantic Versioning

Follow [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH):

- **MAJOR** (x.0.0): Breaking changes to API
- **MINOR** (x.y.0): New features, backward compatible
- **PATCH** (x.y.z): Bug fixes, internal improvements

Example progression:
1.0.0 → 1.0.1 (patch) → 1.1.0 (minor) → 2.0.0 (major)

## Workflows

### `npm-publish.yml` (Automatic)

Triggers on **every push to main** branch.

**When to use:**
- Continuous deployment environment
- Every merged PR should publish
- High confidence in automation

**Note:** It won't fail if version already exists.

### `release.yml` (Manual)

Manually triggered from GitHub Actions UI.

**When to use:**
- Controlled releases
- Batch multiple changes into one release
- Prerelease versions
- Need to review before publishing

## Authentication

Both workflows use **npm Trusted Publishing** (via OpenID Connect):
- ✅ No stored npm tokens
- ✅ Works with 2FA enabled
- ✅ Secure by default
- ✅ Authorized via GitHub Actions environment

## Troubleshooting

### Workflow fails to publish

1. Check GitHub Actions logs:
   - Go to: https://github.com/zonlabs/mcp-ts/actions
   - Click failed workflow run
   - Review error logs

2. Common issues:
   - **Version already exists**: Next release will skip (due to continue-on-error)
   - **Network error**: Retry the workflow
   - **Auth failure**: npm Trusted Publishing needs valid config

### Already published a version?

Just run the workflow again with the next version bump.
The npm-publish step has `continue-on-error: true`, so it won't fail.

## Version History

- **1.3.7**: Latest published version
- View all releases: https://github.com/zonlabs/mcp-ts/releases

## See Also

- [npm Docs: Publishing Packages](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [GitHub Actions](https://docs.github.com/actions)
- [Trusted Publishing](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages)
