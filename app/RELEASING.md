# Releasing Brosr

The app carries its own updater. A tag builds the installers, signs them and
publishes `latest.json` beside them. An installed app reads that file on launch
and again every six hours, then offers the new version.

## Before the first release

1. The repository must be public. An installed app fetches `latest.json` without
   a token. A private repository answers 404 and every check fails quietly.
2. Generate the signing key once:

   ```sh
   cd app
   npx tauri signer generate -w ../.secrets/brosr.key
   ```

   Keep the key and its password out of the repository. The `.secrets/` folder
   stays outside version control.
3. Put the public half of that key in `app/src-tauri/tauri.conf.json` at
   `plugins.updater.pubkey`. Every install refuses a release signed with another
   key.
4. Add two repository secrets. `TAURI_SIGNING_PRIVATE_KEY` holds the key file
   contents. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` holds its password.
5. Check `plugins.updater.endpoints`. It must name the repository that publishes
   the release:

   ```
   https://github.com/<owner>/<repo>/releases/latest/download/latest.json
   ```

## The cycle

```sh
cd app
npm run release 0.3.0
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "Release 0.3.0"
git tag -a v0.3.0 -m "Brosr 0.3.0"
git push origin HEAD v0.3.0
```

The script writes the version to the three files Tauri reads. It also moves the
lock entry and prints the commands above. It refuses to run when those files
already disagree, because a tag built from a mixed tree names one version and
ships another.

The tag and `src-tauri/tauri.conf.json` must name the same version. The workflow
builds `v__VERSION__` from the config. Drift publishes a release that no
installed app offers.

## Check the result

```sh
curl -sL https://github.com/<owner>/<repo>/releases/latest/download/latest.json
```

`version` must equal the tag. Each platform must carry a `signature`. A draft
release or a missing `latest.json` both answer 404 here, which is the same thing
an installed app sees.

## What the app does

- Checks on launch and every six hours while the window is open.
- Shows one dialog for each release.
- Later hides that version until the next release.
- Install downloads in place and restarts the app.

The check never blocks setup. Offline, a rate limit and an empty channel all
answer the same way, and the app continues without a dialog.

## When it breaks

| Symptom | Cause |
| --- | --- |
| The check returns 404 | The repository is private, the release is a draft, or `latest.json` did not upload |
| The workflow fails at signing | A secret is missing or someone pasted the key without its full contents |
| The app offers an old version | The tag and the config disagree |
| Install refuses the bundle | The public key in the config does not match the signing key |
| Gatekeeper or SmartScreen warns | Expected until macOS notarisation and Windows signing. This is separate from the updater signature |
