const { Client } = require('pg');
const fs = require('fs'); // Modul bawaan Node.js untuk membuat file indikator

// GANTI DENGAN CONNECTION STRING NEON ANDA
const connectionString = 'postgresql://neondb_owner:npg_dD7umJ2anOVc@ep-small-meadow-ao60gqis-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const client = new Client({ connectionString });

async function fetchDataAndInsert() {
  await client.connect();
  console.log("Terhubung ke database Neon.");

  // TRICK 1: Cek jumlah data yang sudah ada di database untuk dijadikan posisi awal (offset)
  console.log("Menghitung data yang sudah ada di database...");
  const countRes = await client.query('SELECT COUNT(*) FROM satuan_pendidikan;');
  let offset = parseInt(countRes.rows[0].count) || 0;
  console.log(`Database saat ini berisi ${offset} baris. Melanjutkan dari offset: ${offset}`);

  const limit = 20; 
  let hasMoreData = true;

  // Catat waktu mulai skrip dijalankan
  const startTime = Date.now();
  const LAMA_MAKSIMAL = 5 * 60 * 60 * 1000; // 5 jam dalam milidetik

  while (hasMoreData) {
    // TRICK 2: Cek apakah skrip sudah berjalan mendekati 5 jam
    if (Date.now() - startTime > LAMA_MAKSIMAL) {
      console.log("⚠️ Sudah berjalan 5 jam! Berhenti dengan aman untuk menghindari timeout GitHub.");
      
      // Buat file penanda 'lanjutkan.txt' agar GitHub Actions tahu harus jalan lagi
      fs.writeFileSync('lanjutkan.txt', 'true');
      break;
    }

    const url = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/360?limit=${limit}&offset=${offset}`;

    try {
      console.log(`Mengambil data dari API dengan offset ${offset}...`);
      const response = await fetch(url);
      const result = await response.json();
      const dataList = result.data;

      if (!dataList || dataList.length === 0) {
        hasMoreData = false;
        console.log("🎉 BERHASIL! Semua data dari API telah selesai ditarik.");
        break;
      }

      for (const item of dataList) {
        const query = `
          INSERT INTO satuan_pendidikan (
            satuan_pendidikan_id, npsn, nama, bentuk_pendidikan,
            bentuk_pendidikan_group, jenis_pendidikan, status_satuan_pendidikan,
            jenjang_pendidikan, pembina, jalur_pendidikan, kode_wilayah,
            nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
          ) ON CONFLICT (satuan_pendidikan_id) DO NOTHING;
        `;

        const values = [
          item.satuanPendidikanId, item.npsn, item.nama, item.bentukPendidikan,
          item.bentukPendidikanGroup, item.jenisPendidikan, item.statusSatuanPendidikan,
          item.jenjangPendidikan, item.pembina, item.jalurPendidikan, item.kodeWilayah,
          item.namaDesa, item.namaKecamatan, item.namaKabupaten, item.namaProvinsi, item.alamatJalan
        ];

        await client.query(query, values);
      }

      console.log(`Berhasil menyimpan data ke database. Total kumulatif data: ${offset + dataList.length}`);
      offset += limit;

      // Jeda 1 detik agar tidak membebani server API belajar.id
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error("Terjadi kesalahan:", error);
      // Jika error karena jaringan/RTO, jangan langsung matikan, coba lagi di loop berikutnya
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  await client.end();
  console.log("Koneksi database ditutup.");
}

fetchDataAndInsert();