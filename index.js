const { Client } = require('pg');

// GANTI DENGAN CONNECTION STRING NEON ANDA
// Formatnya: postgresql://[user]:[password]@[neon_hostname]/[dbname]?sslmode=require
const connectionString = 'postgresql://neondb_owner:npg_dD7umJ2anOVc@ep-small-meadow-ao60gqis-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const client = new Client({
  connectionString: connectionString,
});

async function fetchDataAndInsert() {
  await client.connect();
  console.log("Terhubung ke database Neon.");

  let offset = 0;
  const limit = 20; // Batas data per request (sesuai URL Anda)
  let hasMoreData = true;

  while (hasMoreData) {
    // URL Endpoint API
    const url = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/360?limit=${limit}&offset=${offset}`;

    try {
      console.log(`Mengambil data dari API dengan offset ${offset}...`);
      const response = await fetch(url);
      const result = await response.json();
      
      const dataList = result.data;

      // Jika data sudah tidak ada, hentikan perulangan (looping)
      if (!dataList || dataList.length === 0) {
        hasMoreData = false;
        console.log("Semua data telah berhasil diambil dan disimpan.");
        break;
      }

      for (const item of dataList) {
        // Query SQL untuk menyimpan data. 
        // Menggunakan ON CONFLICT untuk mengabaikan jika data dengan ID tersebut sudah ada.
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

        // Mapping data JSON per kolom untuk dimasukkan ke database
        const values = [
          item.satuanPendidikanId, item.npsn, item.nama, item.bentukPendidikan,
          item.bentukPendidikanGroup, item.jenisPendidikan, item.statusSatuanPendidikan,
          item.jenjangPendidikan, item.pembina, item.jalurPendidikan, item.kodeWilayah,
          item.namaDesa, item.namaKecamatan, item.namaKabupaten, item.namaProvinsi, item.alamatJalan
        ];

        await client.query(query, values);
      }

      console.log(`Berhasil menyimpan ${dataList.length} baris data ke database.`);
      
      // Tambahkan offset untuk memuat halaman selanjutnya
      offset += limit;

      // Beri jeda 1 detik antar request agar tidak diblokir oleh server API (Rate Limiting)
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error("Terjadi kesalahan:", error);
      hasMoreData = false; // Hentikan proses jika terjadi error kritis
    }
  }

  await client.end();
  console.log("Koneksi database ditutup.");
}

// Jalankan fungsi
fetchDataAndInsert();