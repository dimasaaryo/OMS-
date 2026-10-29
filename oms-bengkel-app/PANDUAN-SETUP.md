# OMS Bengkel: panduan setup

Versi ini berjalan **tanpa koneksi WMS**. Stok, lokasi bin, pengambilan barang, goods issue, retur, dan stock opname dikelola langsung di aplikasi lewat menu **Gudang**. Koneksi ke WMS bisa dinyalakan nanti (lihat bagian terakhir).

| Bagian | File | Tempat |
| --- | --- | --- |
| Tampilan web | `index.html`, `app.js`, `styles.css`, `config.js` | GitHub Pages |
| Database & login | `supabase/schema.sql`, `supabase/stok-internal.sql` | Supabase |
| Penghubung WMS (nanti) | `supabase/functions/wms/index.ts` | Belum dipakai |

Semua langkah lewat browser, sekitar 20 menit.

---

## 1. Buat project Supabase

1. Daftar di <https://supabase.com> (bisa pakai akun GitHub).
2. **New project** → nama `oms-bengkel` → buat password database (simpan) → region **Southeast Asia (Singapore)**.
3. Tunggu 1–2 menit sampai project siap.

## 2. Buat database (2 file, berurutan)

Di Supabase buka **SQL Editor** → **New query**:

1. Salin **seluruh** isi `supabase/schema.sql` → tempel → **Run**. Harus "Success".
2. **New query** lagi → salin seluruh isi `supabase/stok-internal.sql` → tempel → **Run**.

Masing-masing cukup dijalankan **sekali**.

## 3. Atur login

**Authentication → Sign In / Providers → Email**: aktif.
- **Confirm email** aktif: karyawan harus klik link di email sebelum bisa masuk.
- Matikan bila ingin langsung bisa masuk setelah daftar.

**Authentication → URL Configuration → Site URL**: `https://dimasaaryo.github.io/OMS-/`

## 4. Isi `config.js`

Di Supabase buka **Project Settings → API**, salin **Project URL** dan **anon public key**:

```js
window.OMS_CONFIG = {
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',
  WMS_MODE: 'internal'
};
```

Anon key memang boleh publik; data dilindungi Row Level Security dan pengecekan peran di setiap aksi. **Jangan** menaruh `service_role key` di file ini.

## 5. Upload ke GitHub

1. Repository `OMS-` → **Add file → Upload files**.
2. Seret **isi** folder `oms-bengkel-app`: `index.html`, `app.js`, `styles.css`, `config.js`, folder `supabase`, dan file ini. File `index.html` lama (prototipe) akan tertimpa.
3. **Commit changes**, tunggu 1–2 menit, buka `https://dimasaaryo.github.io/OMS-/`, tekan **Ctrl+F5**.

## 6. Akun pertama & data awal

1. Klik **Belum punya akun? Daftar**. Akun **pertama** otomatis jadi **Admin** aktif.
2. Isi **Master Data** berurutan:
   - **Bay**: sudah ada Bay 1–6, sesuaikan.
   - **Tarif jasa**.
   - **Sparepart**: SKU, nama, satuan, harga, lokasi bin, stok minimum.
   - **Pelanggan** B2B / bengkel mitra beserta TOP & limit kredit.
   - **Pengaturan**: nama & alamat bengkel, batas diskon SA, lama reservasi sementara WO.
3. Buka **Gudang** → tombol **Opname** di tiap part → isi stok fisik awal, alasan "Stok awal".
4. Karyawan lain mendaftar sendiri, lalu Admin mengaktifkan dan memberi peran di **Master Data → Pengguna**:

| Peran | Pekerjaan di aplikasi |
| --- | --- |
| Service Advisor | Check-in, buat WO, jasa & part, kirim estimasi WhatsApp, catat persetujuan |
| Mekanik | WO yang ditugaskan, diagnosa, minta part, update status, retur part tak terpasang |
| Kepala Bengkel | Tugaskan mekanik & bay, QC, approve diskon, master jasa/part/bay, akses gudang |
| Sales Counter | SO eksternal, terima pembayaran retail, kirim permintaan ambil barang |
| Admin Gudang | Ambil barang, serahkan (goods issue), terima retur & barang masuk, stock opname |
| Kasir / Finance | Invoice, catat pembayaran, approve SO yang melebihi limit kredit |
| Admin | Semua, termasuk pengguna & pengaturan |

## Alur kerja

**Servis:** Check-in (4 foto) → Kepala Bengkel tugaskan mekanik & bay → diagnosa → SA tambah jasa & part (stok langsung direservasi sementara) → kirim estimasi WhatsApp → catat persetujuan (reservasi jadi tetap) → **Kirim permintaan ambil barang** → Gudang: Mulai ambil → Selesai ambil → **Serahkan (goods issue)** → dikerjakan → QC → Siap Ambil → Kasir terbitkan invoice & catat bayar → tutup WO.

**Penjualan eksternal:** SO baru → konfirmasi (cek limit kredit; lewat limit → approval Finance) → retail bayar dulu → permintaan ambil barang → Gudang serahkan → invoice.

**Aturan stok:**
- Available = on-hand − reserved − karantina.
- Stok kurang → backorder, terisi otomatis saat Gudang menerima barang.
- Barang kurang di rak saat diambil → sisanya jadi backorder dan stok sistem dikoreksi otomatis.
- Reservasi sementara WO lepas otomatis bila lewat batas jam tanpa persetujuan. SO retail yang belum bayar kedaluwarsa setelah 24 jam.
- Semua pergerakan stok tercatat di `stock_moves`, semua perubahan dokumen di `audit_log`.

## Masalah umum

| Gejala | Solusi |
| --- | --- |
| "Belum dikonfigurasi" | `config.js` belum diisi / belum ter-upload |
| "Akun belum diaktifkan" | Admin aktifkan di Master Data → Pengguna |
| "function ... does not exist" | `stok-internal.sql` belum dijalankan |
| Foto check-in gagal | `schema.sql` belum dijalankan (membuat tempat foto) |
| Tampilan tidak berubah setelah upload | Tunggu 2 menit lalu Ctrl+F5 |

---

## Nanti: menyambungkan ke WMS

Saat WMS dan dokumentasi API-nya siap:
1. Pasang Edge Function `wms` dari `supabase/functions/wms/index.ts` (Supabase → Edge Functions → Via Editor), matikan *Verify JWT*.
2. Isi Secrets: `WMS_BASE_URL`, `WMS_API_TOKEN`, `WMS_WAREHOUSE`, `WMS_WEBHOOK_SECRET`.
3. Ubah `WMS_MODE: 'wms'` di `config.js`.

Data WO, SO, invoice, dan riwayat tetap utuh.
