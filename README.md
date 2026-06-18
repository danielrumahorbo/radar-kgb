# KGB-RADAR Branch Ready

Versi ini adalah KGB-RADAR yang disederhanakan untuk kebutuhan cabang:

- Upload Easy Scrap dari website
- Upload data LVM existing dari website
- Auto-cleaning dan matching merchant
- Merchant radar map
- Today's visit queue
- Form catat kunjungan merchant
- Capture QRIS/EDC provider dan kompetitor
- Export visit report
- Supabase database optional untuk penyimpanan permanen tanpa login

## File penting

- `main.jsx` = struktur dashboard, upload, map, visit tracking, Supabase sync
- `styles.css` = desain UI/UX Bank Mandiri tone
- `supabase_sql.sql` = SQL schema yang perlu dijalankan di Supabase
- `merchant_seed.json` = data awal merchant
- `lvm_kgb_light.json` = data awal LVM light
- `branches_jabodetabek_seed.json` = data seed cabang Mandiri
- `competitors_seed.json` = data seed kompetitor
- `areas_kelapa_gading.json` = polygon area Kelapa Gading

## Deploy Vercel

Framework: Vite
Install command: npm install
Build command: npm run build
Output directory: dist
Root directory: kosongkan jika semua file ada di root repo

## Supabase environment variables

Tambahkan di Vercel:

VITE_SUPABASE_URL=isi project URL Supabase
VITE_SUPABASE_ANON_KEY=isi anon public key Supabase

Jika env belum diisi, aplikasi tetap jalan memakai Local Mode, tetapi data visit hanya tersimpan di browser.
