# Releasing

DeepClause for pi depends on SDK features first published in `deepclause-sdk` 0.0.87. Release in dependency order.

## 1. Publish the SDK

From the sibling `deepclause-sdk` repository:

```sh
npm ci
npm run build
npx vitest run tests/injected-llm-backend.test.ts
npm pack --dry-run
git add .
git commit -m "Release 0.0.87"
git tag v0.0.87
npm publish --access public
git push origin main --tags
```

Confirm `npm view deepclause-sdk version` reports `0.0.87` before continuing.

## 2. Release the pi extension

Once the SDK is available from npm:

```sh
npm ci
npm run check
npm pack --dry-run
git add .
git commit -m "Release deepclause-pi 0.1.2"
git tag -a v0.1.2 -m "deepclause-pi 0.1.2"
git push origin main --tags
```

Create a GitHub release from tag `v0.1.2`, using the `0.1.2` section of `CHANGELOG.md` as the release notes. Do not attach a generated tarball; GitHub provides source archives and pi installs directly from the repository.

Users can then install the extension with:

```sh
pi install git:github.com/deepclause/deepclause-pi
```

Publishing the extension to npm is optional and is not required for `pi install git:github.com/deepclause/deepclause-pi`. If publishing to npm, authenticate with npm, confirm the name is available with `npm view deepclause-pi`, and run `npm publish --access public`; the package already runs `npm run check` through `prepublishOnly`.
