const { Client } = require('pg');

const connectionString = 'postgresql://neondb_owner:npg_dD7umJ2anOVc@ep-small-meadow-ao60gqis-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const client = new Client({ connectionString });

async function ambilDataAwal() {
  await client.connect();
  console.log("Terhubung ke Neon. Mulai menarik data pondasi dari devapi.id...");

  let offset = 0;
  const limit = 100; // Limit lebih besar!
  let hasMoreData = true;

  while (hasMoreData) {
    const url = `https://sekolah.devapi.id/sekolah?limit=${limit}&offset=${offset}`;

    try {
      console.log(`Mengambil data devapi.id offset ${offset}...`);
      const response = await fetch(url);
      const result = await response.json();
      
      const dataList = result.data;

      if (!dataList || dataList.length === 0) {
        hasMoreData = false;
        console.log("🎉 PENGAMBILAN DATA PONDASI SELESAI!");
        break;
      }

      for (const item of dataList) {
        // PERUBAHAN: Nama kolom kementerian_pembina -> pembina dan jalan -> alamat_jalan
        const query = `
          INSERT INTO satuan_pendidikan (
            npsn, nama, bentuk_pendidikan, jalur_pendidikan, jenjang_pendidikan, 
            pembina, status_satuan_pendidikan, akreditasi, jenis_pendidikan,
            alamat_jalan, rt, rw, nama_dusun, nama_desa, nama_kecamatan, nama_kabupaten, 
            nama_provinsi, kode_wilayah, lintang, bujur, email, website, nomor_telepon,
            sk_pendirian, nama_yayasan, luas_tanah
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
          ) ON CONFLICT (npsn) DO NOTHING;
        `;

        const values = [
          item.npsn, 
          item.nama, 
          item.bentukPendidikan, 
          item.jalurPendidikan, 
          item.jenjangPendidikan,
          item.kementerianPembina,      // Masuk ke kolom 'pembina'
          item.statusSatuanPendidikan, 
          item.akreditasi, 
          item.jenisPendidikan,
          item.alamat?.jalan || '',     // Masuk ke kolom 'alamat_jalan'
          item.alamat?.rt || '', 
          item.alamat?.rw || '', 
          item.alamat?.nama_dusun || '',
          item.alamat?.nama_desa || '', 
          item.alamat?.nama_kecamatan || '', 
          item.alamat?.nama_kabupaten || '', 
          item.alamat?.nama_provinsi || '', 
          item.alamat?.kode_wilayah || '',
          item.lokasi?.lintang || null, 
          item.lokasi?.bujur || null,
          item.kontak?.email || '', 
          item.kontak?.website || '', 
          item.kontak?.nomor_telepon || '',
          item.dokumen_perizinan?.sk_pendirian_sekolah?.nomor || '',
          item.yayasan?.nama || '',
          item.sarana_prasarana?.luas_tanah_milik || ''
        ];

        await client.query(query, values);
      }

      offset += limit;
      
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error("Terjadi kesalahan:", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  await client.end();
}

ambilDataAwal();