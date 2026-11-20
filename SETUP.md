# Rumah by Dinakara — satu repo, satu deploy

```
rumah.bydinakara.com/            landing page
rumah.bydinakara.com/booking     aplikasi booking (bkr-booking)
rumah.bydinakara.com/galeri      galeri klien + dasbor (berkunjungkerumah)
rumah.bydinakara.com/api/*       server booking (Vercel Functions)
```

Semua pengaturan Vercel sudah ada di `vercel.json` (tidak perlu isi Framework/Output Directory/Build Command).

## 1. Upload ke GitHub
1. Ekstrak zip, buat repo GitHub baru (mis. `rumah-bydinakara`, **Private**).
2. Add file > Upload files > seret **isi** folder (bukan zipnya): `api`, `lib`, `public`, `backend`, `test`, `vercel.json`, `package.json`, `SETUP.md`, `.gitignore`.

## 2. Backend landing (Google Apps Script) — sekali saja
1. Buat Google Sheet baru > Extensions > Apps Script > tempel isi `backend/landing-Code.gs`.
2. Project Settings > Script properties > tambah `ADMIN_PIN` = PIN rahasia, **minimal 6 karakter**. (Tanpa ini semua aksi admin ditolak. Tidak ada PIN bawaan.)
3. Deploy > New deployment > Web app > Execute as **Me**, Who has access **Anyone**. Salin URL `/exec`.
4. Di GitHub buka `public/index.html`, cari `const DEFAULT_GAS_URL = '';`, tempel URL `/exec` di antara tanda kutip, lalu Commit.
   (Wajib: tanpa ini pengunjung tidak menerima perubahan dari dashboard.)

## 3. Backend booking & galeri — tidak berubah
- Booking: pakai Apps Script + Google Sheet yang sudah ada (`backend/booking-apps-script.gs` sama dengan versi sebelumnya, tidak perlu deploy ulang).
- Galeri: pakai dua Apps Script brand yang sudah ada (URL-nya ada di `public/galeri/config.js`).

## 4. Vercel
1. Add New > Project > import repo. Jangan ubah pengaturan build.
2. Environment Variables (sama dengan project booking lama):

| Nama | Isi |
|---|---|
| `GSHEET_WEBHOOK_URL` | URL `/exec` Apps Script **booking** |
| `GSHEET_SECRET` | sama persis dengan Script Property `SECRET` di Apps Script booking |
| `ADMIN_PASSWORD` | password admin booking (panjang, unik) |
| `SESSION_SECRET` | acak >= 32 karakter, **berbeda** dari password |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | opsional |

3. Deploy. Setelah itu Settings > Domains > tambah `rumah.bydinakara.com`, lalu buat record DNS persis seperti yang ditampilkan Vercel (biasanya CNAME `rumah` ke `cname.vercel-dns.com`). Bila memakai Cloudflare, awalnya set **DNS only** (awan abu-abu).

## 5. Cek setelah live
- `/` tampil, tombol Booking menuju `/booking`
- `/booking` tampil; `/booking/?akses=ruang-admin` membuka login admin
- `/galeri` tampil; `/galeri/admin` meminta PIN; `/galeri/g/<kode>` membuka galeri
- `/?akses=ruang-admin` (atau Ctrl+Shift+K) memunculkan dashboard landing
- Terminal: `curl -sI https://rumah.bydinakara.com/booking | grep -i content-security` harus menampilkan CSP

## 6. Sebelum diumumkan
- Ganti testimoni contoh di dashboard landing dengan testimoni klien asli (isi bawaan memakai nama dan foto stok).
- Pastikan nomor WhatsApp tombol Kontak benar (saya isi `6289673859670`, dari config galeri brand Berkunjung ke Rumah).
- Booking: login admin, tab Pengaturan, isi rekening dan nomor WA admin (form booking terkunci sampai terisi).

## 7. Link lama klien
Project Vercel lama (`berkunjungkerumah`, `dinakara-gallery`, `bkr-booking`) jangan dihapus dulu: link galeri yang sudah dibagikan tetap hidup. Link baru dari dasbor galeri memakai `https://rumah.bydinakara.com/galeri/g/<kode>`.

## Tes
`npm test` menjalankan 51 tes (booking, API, Apps Script landing, routing, CSP).
