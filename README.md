# Vault Compare

A local, read-only dashboard for verifying that each project below `T:\vault` exists in Dropbox with the same folders, files, and file sizes. It does not download or alter vault or Dropbox files.

## Run with Docker

1. Ensure Docker Desktop can access the `T:` drive.
2. From this directory, run `docker compose up --build`.
3. Open `http://localhost:3000`.

`docker-compose.yml` mounts `T:/vault` at `/vault:ro`. The `:ro` flag is intentional and must not be removed. App data (configuration, OAuth credentials, inventories, and scan history) lives in the named Docker volume `vault_compare_data`.

## Deploy as a Portainer stack

1. In the stack's **Environment variables** section, set `VAULT_HOST_PATH` to the vault path on the machine running Portainer (for example, `T:/vault` on Docker Desktop for Windows or `/mnt/vault` on Linux). Optionally set `APP_PORT` to the external port you want to use; it defaults to `3000`. These are entered in Portainer, not stored in a `.env` file. Keep the `/vault:ro` destination and read-only suffix unchanged.
2. In Portainer, choose **Stacks → Add stack → Repository**.
3. Use repository URL `https://github.com/isolytic/isolytic-dropbox.git`, select the default branch, and set the compose path to `docker-compose.portainer.yml`.
4. Deploy the stack and open `http://<portainer-host>:<APP_PORT>`.

Portainer pulls the published image; no `.env` file or Portainer environment variables are required. Configuration and Dropbox login remain inside the app UI. The named `vault_compare_data` volume persists settings and scan history across redeployments.

## First-time Dropbox setup

The setup page uses a generated Dropbox access token—there is no OAuth browser redirect. In the [Dropbox App Console](https://www.dropbox.com/developers/apps), create a **Full Dropbox** app, enable the `files.metadata.read` scope, and click **Generate** in its OAuth 2 section. Paste that token and the Dropbox mirror root into the app; it validates both before saving them. The Settings dialog can export/import a copy-paste connection bundle between local and production instances; it contains credentials, so handle it as you would a password.

Dropbox may expire or revoke generated tokens. If that happens, generate and paste a replacement token in Settings before the next scan.

## Scan behavior

- One durable scan queue prevents API bursts. Dropbox listings use recursive pagination, save cursors after every page, honor `Retry-After`, and retry temporary service errors with backoff.
- Each immediate child folder of `/vault` maps to the same-named child of the configured Dropbox root.
- A missing Dropbox project is a mismatch. Dropbox-only files are reported separately as additions. Dropbox-only top-level folders appear as **Additional Dropbox projects**.
- Timestamps and file contents are ignored. Missing entries, additional entries, file/folder conflicts, and same-path file-size differences are reported.
- Symlinks and junctions are not followed. Any local read or Dropbox API failure leaves that scan **Incomplete**, not matched.
- History retention defaults to five completed scans and can be changed in Settings.
- Each completed project has a side-by-side **Browse** view. It navigates the saved scan inventory folder-by-folder, so it does not rescan the vault or make Dropbox calls.

## Local development

Run `npm install` once, then `npm run dev`. The Vite development UI proxies API calls to the server on port 3000. For a local test vault or database location, set `VAULT_ROOT` and `DATA_DIR` in your shell; no `.env` file is required.

## Versioning

The version in `package.json` is shown in the application footer. Bump it for every app update before building or deploying; Docker and Portainer builds embed that version in the UI.
