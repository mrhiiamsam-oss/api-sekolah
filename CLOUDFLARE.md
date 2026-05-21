# Sinkron via Cloudflare Workers (pengganti GitHub Actions)

GitHub Actions dibatasi billing? Deploy Worker ini — state offset tetap di Neon (`status_sinkronisasi`).

## Cara kerja

| Trigger | Perilaku |
|---------|----------|
| **Cron `*/5 * * * *`** | Setiap 5 menit, proses batch ~28 detik, simpan `offset_terakhir`, lalu berhenti |
| **Cron `0 16 * * 6`** | Sabtu 23:00 WIB — mulai dari **offset 0** (scan mingguan) |
| **GET `/sync?secret=...`** | Jalankan manual (lanjut atau `&awal=1`) |

Tidak perlu `lanjutkan.txt` — offset di Neon yang mengatur lanjutan.

## Persyaratan

- Akun [Cloudflare](https://dash.cloudflare.com) (gratis)
- **Workers Paid** (~$5/bulan) disarankan — plan gratis CPU sangat kecil untuk banyak query DB + API
- Connection string Neon (sama seperti `.env`)

## Deploy (sekali)

```bash
npm install
npx wrangler login
npx wrangler secret put DATABASE_URL
# paste connection string Neon, Enter

npx wrangler secret put CRON_SECRET
# buat password acak untuk trigger manual, Enter

npm run worker:deploy
```

## Trigger manual

Ganti `YOUR_WORKER` dan `SECRET`:

```
https://fetch-data-belajar-sync.<subdomain>.workers.dev/sync?secret=SECRET&awal=0
```

- `awal=0` — lanjut dari offset di Neon (mis. 131740)
- `awal=1` — reset ke 0

## Set offset manual (sama seperti sebelumnya)

Di Neon SQL Editor:

```sql
UPDATE status_sinkronisasi SET offset_terakhir = 131740 WHERE id = 1;
```

Lalu panggil `/sync?secret=...&awal=0` atau tunggu cron 5 menit.

## Nonaktifkan GitHub Actions

Di repo GitHub: **Actions** → workflow **Tarik Data API ke Neon** → **⋯** → **Disable workflow**.

Atau hapus/comment file `.github/workflows/jalankan-skrip.yml`.

## Lokal (Node, opsional)

```bash
node index.js --awal
```

Tetap memakai `pg` + `.env` untuk debug panjang; produksi pakai Worker.
