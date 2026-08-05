# Releasing Silvic

Silvic ships directly from GitHub Releases. Each macOS release contains a
universal Developer ID-signed and Apple-notarized app in a DMG, plus the ZIP and
`latest-mac.yml` that the in-app updater needs.

## One-time GitHub setup

Create a GitHub Actions environment named `release`. Store these secrets in that
environment, never in the repository:

- `MAC_CSC_LINK` — the base64-encoded Developer ID Application `.p12`
- `MAC_CSC_KEY_PASSWORD` — the export password for that `.p12`
- `APPLE_API_KEY_P8` — the base64-encoded App Store Connect API private key
- `APPLE_API_KEY_ID` — the API key ID
- `APPLE_API_ISSUER` — the API issuer ID

Restrict that environment to selected tags matching `v*`. This keeps the
Developer ID private key and Apple notarization key unavailable to branches and
pull requests even if another workflow references the environment later.

The release job receives repository `contents: write` only. Pull requests and
forks never run the tag workflow and never receive the release secrets.

## Publish a version

Start from a clean, reviewed `main`:

```bash
pnpm release:version 0.1.1
pnpm check
git add package.json apps/desktop/package.json
git commit -m "release: v0.1.1"
git tag v0.1.1
git push origin main v0.1.1
```

The tag must exactly match `apps/desktop/package.json`. GitHub Actions then:

1. repeats the full source checks;
2. builds one Universal macOS app;
3. signs every executable with Developer ID and enables Hardened Runtime;
4. submits the app to Apple's notary service and staples the ticket;
5. verifies the signature, Gatekeeper assessment, ticket and update metadata;
6. creates the public GitHub Release only after every verification passes.

An installed Silvic checks shortly after launch and every four hours. It never
downloads without a click: **Update to …** downloads the release, and only
**Restart to update** quits and installs it.

## Install on another Mac

Open the repository's public GitHub Releases page on the other Mac, download the
DMG for the newest version, open it, and drag Silvic into `/Applications`. The
Universal build runs natively on both Apple Silicon and Intel Macs. On first
launch, macOS verifies the Developer ID signature and Apple's notarization
ticket; no `xattr` command or Gatekeeper bypass is needed. Future versions appear
inside Silvic's sidebar and use the update flow above.

## Verify a published release

After downloading the DMG:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Silvic.app
spctl --assess --type execute --verbose=4 /Applications/Silvic.app
xcrun stapler validate /Applications/Silvic.app
```

Gatekeeper should report `source=Notarized Developer ID`.
