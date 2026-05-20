const { Client } = require('pg');
const fs = require('fs');

// String koneksi menggunakan database Neon Anda
const connectionString = 'postgresql://neondb_owner:npg_dD7umJ2anOVc@ep-small-meadow-ao60gqis-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const client = new Client({ connectionString });

async function fetchDataAndInsert() {
  await client.connect();
  console.log("Terhubung ke database Neon.");

  const stateRes = await client.query('SELECT offset_terakhir FROM status_sinkronisasi WHERE id = 1;');
  let offset = parseInt(stateRes.rows[0].offset_terakhir);
  console.log(`Memulai/melanjutkan sinkronisasi dari offset: ${offset}`);

  const limit = 20; 
  let hasMoreData = true;

  const startTime = Date.now();
  const LAMA_MAKSIMAL = 5 * 60 * 60 * 1000; // 5 jam

  while (hasMoreData) {
    if (Date.now() - startTime > LAMA_MAKSIMAL) {
      console.log("⚠️ Mendekati 5 jam! Berhenti untuk menghindari timeout GitHub.");
      fs.writeFileSync('lanjutkan.txt', 'true');
      break;
    }

    const url = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/360?limit=${limit}&offset=${offset}`;

    try {
      console.log(`Mengecek API offset ${offset}...`);
      const response = await fetch(url);
      const result = await response.json();
      const dataList = result.data;

      // JIKA DATA SUDAH HABIS (SINKRONISASI SELESAI 100%)
      if (!dataList || dataList.length === 0) {
        hasMoreData = false;
        console.log("🎉 SINKRONISASI SELESAI! Semua data telah dicek.");
        
        // Kembalikan offset ke 0 DAN catat waktu selesai saat ini (NOW())
        await client.query(`
          UPDATE status_sinkronisasi 
          SET offset_terakhir = 0, waktu_selesai_terakhir = NOW() 
          WHERE id = 1;
        `);
        break;
      }

      for (const item of dataList) {
        // PERUBAHAN: Sekarang mendeteksi konflik berdasarkan (npsn)
        const query = `
          INSERT INTO satuan_pendidikan (
            npsn, satuan_pendidikan_id, nama, bentuk_pendidikan,
            bentuk_pendidikan_group, jenis_pendidikan, status_satuan_pendidikan,
            jenjang_pendidikan, pembina, jalur_pendidikan, kode_wilayah,
            nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
          ) ON CONFLICT (npsn) DO UPDATE SET
            satuan_pendidikan_id = EXCLUDED.satuan_pendidikan_id,
            nama = EXCLUDED.nama,
            bentuk_pendidikan = EXCLUDED.bentuk_pendidikan,
            bentuk_pendidikan_group = EXCLUDED.bentuk_pendidikan_group,
            jenis_pendidikan = EXCLUDED.jenis_pendidikan,
            status_satuan_pendidikan = EXCLUDED.status_satuan_pendidikan,
            jenjang_pendidikan = EXCLUDED.jenjang_pendidikan,
            pembina = EXCLUDED.pembina,
            jalur_pendidikan = EXCLUDED.jalur_pendidikan,
            kode_wilayah = EXCLUDED.kode_wilayah,
            nama_desa = EXCLUDED.nama_desa,
            nama_kecamatan = EXCLUDED.nama_kecamatan,
            nama_kabupaten = EXCLUDED.nama_kabupaten,
            nama_provinsi = EXCLUDED.nama_provinsi,
            alamat_jalan = EXCLUDED.alamat_jalan
          WHERE 
            satuan_pendidikan.satuan_pendidikan_id IS NULL OR
            satuan_pendidikan.satuan_pendidikan_id IS DISTINCT FROM EXCLUDED.satuan_pendidikan_id OR
            satuan_pendidikan.nama IS DISTINCT FROM EXCLUDED.nama OR
            satuan_pendidikan.status_satuan_pendidikan IS DISTINCT FROM EXCLUDED.status_satuan_pendidikan OR
            satuan_pendidikan.alamat_jalan IS DISTINCT FROM EXCLUDED.alamat_jalan;
        `;

        // PERUBAHAN: Posisi array disesuaikan (npsn di urutan pertama/$1)
        const values = [
          item.npsn,                         // $1
          item.satuanPendidikanId,           // $2
          item.nama,                         // $3
          item.bentukPendidikan,             // $4
          item.bentukPendidikanGroup,        // $5
          item.jenisPendidikan,              // $6
          item.statusSatuanPendidikan,       // $7
          item.jenjangPendidikan,            // $8
          item.pembina,                      // $9
          item.jalurPendidikan,              // $10
          item.kodeWilayah,                  // $11
          item.namaDesa,                     // $12
          item.namaKecamatan,                // $13
          item.namaKabupaten,                // $14
          item.namaProvinsi,                 // $15
          item.alamatJalan                   // $16
        ];

        await client.query(query, values);
      }

      offset += limit;
      
      await client.query('UPDATE status_sinkronisasi SET offset_terakhir = $1 WHERE id = 1;', [offset]);
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error("Terjadi kesalahan jaringan/database:", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  await client.end();
  console.log("Koneksi database ditutup.");
}

fetchDataAndInsert();