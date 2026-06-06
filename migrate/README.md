# Migrating the ERA5 data to Cloudflare R2 (zero egress)

This moves the ~2.5 GB of ERA5 tiles the game reads off GCS (which charges
egress) and onto **Cloudflare R2** (no egress fees, ~$0.04/mo storage — almost
certainly free at the 10 GB free tier). The game itself stays on GitHub Pages;
only the *data* source changes, via a one-line config in `index.html`.

The steps that need your Cloudflare account are **1–7** (only you can do those);
once your bucket is public I'll wire up `index.html` and verify.

---

### 1. Install rclone
<https://rclone.org/install/>  (macOS: `brew install rclone`)

### 2. Create the R2 bucket
Cloudflare dashboard → **R2** → *Create bucket* → name it `seedstorm-data`
(any name; pass it to the script if different). Note your **Account ID**
(shown on the R2 overview page).

### 3. Create an R2 API token
R2 → *Manage R2 API Tokens* → *Create API token* → **Object Read & Write** →
create. Copy the **Access Key ID** and **Secret Access Key** (shown once).

### 4. Configure the rclone remote (name it `r2`)
Run `rclone config` → `n` (new remote):
- name: **r2**
- storage: **Amazon S3** → provider: **Cloudflare R2**
- env_auth: false
- access_key_id / secret_access_key: from step 3
- region: `auto`
- endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

Test: `rclone lsd r2:` should list your bucket.

### 5. Copy the tiles
```sh
cd migrate
chmod +x migrate_to_r2.sh
./migrate_to_r2.sh seedstorm-data 8      # bucket name, parallelism
```
~1,064 objects, a few minutes. (~$0.30 one-time GCS egress for the copy; $0
after.) Re-run to retry any failures — it overwrites idempotently.

### 6. Make the bucket public
Bucket → **Settings** → **Public access**. Either:
- **r2.dev** dev URL: *Allow Access* → gives `https://pub-<hash>.r2.dev`
  (fine for testing; rate-limited, not for heavy use), **or**
- **Custom domain** (recommended for sharing): connect a domain/subdomain you
  manage on Cloudflare → gives e.g. `https://data.yourdomain.com`.

Note the public base URL — call it `<R2_BASE>`.

### 7. Set CORS
Bucket → **Settings** → **CORS Policy** → paste the contents of
[`r2-cors.json`](r2-cors.json). (Add your custom-domain game origin if you use
one besides `michaelfischerwx.github.io`.)

### 8. Point the game at R2  *(I can do this)*
Uncomment the `window.SEEDSTORM_DATA` block in `index.html` and set:
```js
window.SEEDSTORM_DATA = {
  daily: '<R2_BASE>/era5_daily_1deg',
  sst:   '<R2_BASE>/sst',
  gcManifest: '<R2_BASE>/gc-manifest.json'
};
```

### 9. Verify  *(I can do this)*
```sh
curl -I -H "Origin: https://michaelfischerwx.github.io" \
  "<R2_BASE>/era5_daily_1deg/manifest.json"
# expect: HTTP/2 200  +  access-control-allow-origin: https://michaelfischerwx.github.io
```
Then load the game and play a round — the ERA5 fetches now come from R2 with
zero egress cost.
