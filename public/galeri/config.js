/* ============================================================
   KONFIGURASI INDUK — satu kode, banyak brand.
   Tambah brand baru cukup dengan menambah satu blok di BRANDS.
   Data tiap brand tetap di Google Apps Script masing-masing,
   jadi semua link galeri klien lama tetap berfungsi.
   ============================================================ */
const CONFIG = {
  PHOTO_MAX_PX: 2048,   // sisi terpanjang untuk versi "Simpan ke Foto"
  PHOTO_QUALITY: 0.9,   // kualitas JPEG (0.1 - 1)

  // Satu alamat admin untuk semua brand. Bila diisi, /admin di link mana pun dialihkan ke sini.
  // Contoh: "https://berkunjungkerumah.vercel.app/admin". Kosongkan bila admin boleh dibuka dari semua link.
  ADMIN_URL: "",

  DEFAULT_BRAND: "dinakara",   // dipakai bila brand tidak bisa dikenali dari domain

  BRANDS: {
    dinakara: {
      name: "DINAKARA VISUAL",
      short: "Dinakara",
      color: "#d9a441",   // warna penanda brand di dashboard (emas)
      wa: "6287787577211",
      api: "https://script.google.com/macros/s/AKfycbzVp4OTX6NxiAz-VZIbaLvcR0USEyJLuzUBskdyEPX3xd2Q5yS-96LfckkbLpcbDBk/exec",
      hosts: ["dinakara-gallery.vercel.app"],   // domain yang otomatis dikenali sebagai brand ini
      domain: "dinakara-gallery.vercel.app"                                // isi dengan domain utama brand agar link klien tetap pendek: "dinakara-gallery.vercel.app" atau domain sendiri
    },
    berkunjungkerumah: {
      name: "BERKUNJUNG KE RUMAH",
      short: "Berkunjung ke Rumah",
      color: "#2fb59d",   // warna penanda brand di dashboard (hijau tosca)
      wa: "6289673859670",
      api: "https://script.google.com/macros/s/AKfycbx3xGvslutU62V7kkbGu1cTkfYandtFBi328IxYpe22SIN80ScTV4DjU7VZlKykyfd-8Q/exec",
      hosts: ["rumah.bydinakara.com", "berkunjungkerumah.vercel.app"],
      domain: "berkunjungkerumah.vercel.app",                               // link lama klien tetap valid selama project Vercel lama masih hidup
      linkBase: "https://rumah.bydinakara.com/galeri/g"                    // link BARU yang dibuat dari dasbor mengarah ke sini
    }
  }
};
