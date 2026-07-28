# Vault Compare

A local, read-only dashboard for verifying that each project below `T:\vault` exists in Dropbox with the same folders, files, and file sizes. It does not download or alter vault or Dropbox files.

## Run with Docker

1. Ensure Docker Desktop can access the `T:` drive.
2. From this directory, run `docker compose up --build`.
3. Open `http://localhost:3000`.

`docker-compose.yml` mounts `T:/vault` at `/vault:ro`. The `:ro` flag is intentional and must not be removed. App data (configuration, OAuth credentials, inventories, and scan history) lives in the named Docker volume `vault_compare_data`.

## Deploy as a Portainer stack

1. Put the vault at `/mnt/vault` on the machine running Portainer, or edit that one host-side path in `docker-compose.portainer.yml`. Keep the `/vault:ro` destination and read-only suffix unchanged.
2. In Portainer, choose **Stacks → Add stack → Repository**.
3. Use repository URL `https://github.com/isolytic/isolytic-dropbox.git`, select the default branch, and set the compose path to `docker-compose.portainer.yml`.
4. Deploy the stack and open `http://<portainer-host>:3000`.

Portainer pulls the published image; no `.env` file or Portainer environment variables are required. Configuration and Dropbox login remain inside the app UI. The named `vault_compare_data` volume persists settings and scan history across redeployments.

## First-time Dropbox setup

The setup page links to the Dropbox App Console. Create a scoped app with **Full Dropbox** access and enable only the read scopes it needs (`files.metadata.read`). Add the exact redirect URI shown by the app, normally:

`http://localhost:3000/api/auth/dropbox/callback`

Paste the App Key, choose the Dropbox mirror root, then connect. The app uses OAuth PKCE with offline access, so scans can run after the browser closes. The Settings dialog can export/import a copy-paste connection bundle between local and production instances; it contains credentials, so handle it as you would a password.

## Scan behavior

- One durable scan queue prevents API bursts. Dropbox listings use recursive pagination, save cursors after every page, honor `Retry-After`, and retry temporary service errors with backoff.
- Each immediate child folder of `/vault` maps to the same-named child of the configured Dropbox root.
- A missing Dropbox project is a mismatch. Dropbox-only files are reported separately as additions. Dropbox-only top-level folders appear as **Additional Dropbox projects**.
- Timestamps and file contents are ignored. Missing entries, additional entries, file/folder conflicts, and same-path file-size differences are reported.
- Symlinks and junctions are not followed. Any local read or Dropbox API failure leaves that scan **Incomplete**, not matched.
- History retention defaults to five completed scans and can be changed in Settings.

## Local development

Run `npm install` once, then `npm run dev`. The Vite development UI proxies API calls to the server on port 3000. For a local test vault or database location, set `VAULT_ROOT` and `DATA_DIR` in your shell; no `.env` file is required.

## Versioning

The version in `package.json` is shown in the application footer. Bump it for every app update before building or deploying; Docker and Portainer builds embed that version in the UI.
