# Landing rumah.bydinakara.com (tahap 1)

Isi: `public/index.html` (landing), `backend/landing-Code.gs` (Apps Script), `vercel.json` (header keamanan + CSP).

## 1. Backend (Google Apps Script) — sekali saja
1. Buat Google Sheet baru > Extensions > Apps Script > hapus isi editor, tempel seluruh isi `backend/landing-Code.gs`.
2. Project Settings (ikon roda gigi) > Script properties > Add: nama `ADMIN_PIN`, isi PIN rahasia **minimal 6 karakter**. Tanpa ini admin selalu ditolak.
3. Deploy > New deployment > Web app > Execute as **Me**, Who has access **Anyone** > Deploy > izinkan akses > salin URL berakhiran `/exec`.

## 2. Pasang URL backend
Di GitHub buka `public/index.html` (ikon pensil), cari `const DEFAULT_GAS_URL = '';`, tempel URL `/exec` di antara tanda kutip, Commit changes.

## 3. GitHub + Vercel
1. Repo baru (mis. `rumah-bydinakara`, Private) > Add file > Upload files > seret **isi** folder ini (`public`, `backend`, `vercel.json`, `SETUP.md`, `.gitignore`) > Commit.
2. Vercel > Add New > Project > pilih repo > Deploy (jangan ubah pengaturan apa pun).
3. Settings > Domains > tambah `rumah.bydinakara.com` > buat record DNS persis seperti yang Vercel tampilkan (biasanya CNAME `rumah` ke `cname.vercel-dns.com`). Jika memakai Cloudflare, awalnya set **DNS only** (awan abu-abu).

## 4. Dashboard landing
Buka `https://rumah.bydinakara.com/?akses=ruang-admin` (atau tekan Ctrl+Shift+K), masukkan PIN dari langkah 1.2. Tombol admin tidak tampil untuk pengunjung.
Setelah login: ganti testimoni contoh dengan testimoni klien asli, cek nomor WhatsApp, isi ID folder Drive slideshow (5-8 foto, tab 4), lalu Simpan.

## Catatan
- Tombol "Booking Sesi" menuju `/booking`; sebelum tahap 2 (penggabungan) akan 404. Sementara bisa diubah di dashboard (tab 3) ke link booking Vercel kamu yang sekarang.
- 5 kali PIN salah mengunci login 15 menit (untuk semua orang, termasuk kamu).
