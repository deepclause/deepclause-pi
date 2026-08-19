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
git add .
git commit -m "Fix SDK dependency for Git installs"
git tag v0.1.1
git push origin main --tags
```

Users can then install the extension with:

```sh
pi install git:github.com/deepclause/deepclause-pi
```

If publishing the extension to npm later, inspect `npm pack --dry-run` and use `npm publish --access public`; the package already runs `npm run check` through `prepublishOnly`.
