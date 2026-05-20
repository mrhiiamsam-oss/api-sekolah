require('dotenv').config();

const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL belum diatur. Set variabel lingkungan secara lokal atau tambahkan secret DATABASE_URL di GitHub.');
  process.exit(1);
}

const client = new Client({ connectionString });

function buildRowFingerprint(item) {
  const payload = {
    nama: item.nama ?? '',
    bentuk_pendidikan: item.bentukPendidikan ?? '',
    bentuk_pendidikan_group: item.bentukPendidikanGroup ?? '',
    jenis_pendidikan: item.jenisPendidikan ?? '',
    status_satuan_pendidikan: item.statusSatuanPendidikan ?? '',
    jenjang_pendidikan: item.jenjangPendidikan ?? '',
    pembina: item.pembina ?? '',
    jalur_pendidikan: item.jalurPendidikan ?? '',
    nama_desa: item.namaDesa ?? '',
    nama_kecamatan: item.namaKecamatan ?? '',
    nama_kabupaten: item.namaKabupaten ?? '',
    nama_provinsi: item.namaProvinsi ?? '',
    alamat_jalan: item.alamatJalan ?? '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

const UPSERT_SEKOLAH = `
  INSERT INTO sekolah (
    npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
    status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
    nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
  ) ON CONFLICT (npsn) DO UPDATE SET
    nama = EXCLUDED.nama,
    bentuk_pendidikan = EXCLUDED.bentuk_pendidikan,
    bentuk_pendidikan_group = EXCLUDED.bentuk_pendidikan_group,
    jenis_pendidikan = EXCLUDED.jenis_pendidikan,
    status_satuan_pendidikan = EXCLUDED.status_satuan_pendidikan,
    jenjang_pendidikan = EXCLUDED.jenjang_pendidikan,
    pembina = EXCLUDED.pembina,
    jalur_pendidikan = EXCLUDED.jalur_pendidikan,
    nama_desa = EXCLUDED.nama_desa,
    nama_kecamatan = EXCLUDED.nama_kecamatan,
    nama_kabupaten = EXCLUDED.nama_kabupaten,
    nama_provinsi = EXCLUDED.nama_provinsi,
    alamat_jalan = EXCLUDED.alamat_jalan,
    row_fp = EXCLUDED.row_fp
  WHERE sekolah.row_fp IS DISTINCT FROM EXCLUDED.row_fp
`;

async function ensureSchema() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sekolah (
      npsn TEXT PRIMARY KEY,
      nama TEXT NOT NULL DEFAULT '',
      bentuk_pendidikan TEXT,
      bentuk_pendidikan_group TEXT,
      jenis_pendidikan TEXT,
      status_satuan_pendidikan TEXT,
      jenjang_pendidikan TEXT,
      pembina TEXT,
      jalur_pendidikan TEXT,
      nama_desa TEXT,
      nama_kecamatan TEXT,
      nama_kabupaten TEXT,
      nama_provinsi TEXT,
      alamat_jalan TEXT,
      migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      row_fp TEXT
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_sekolah_nama ON sekolah (nama);
    CREATE INDEX IF NOT EXISTS idx_sekolah_kabupaten ON sekolah (nama_kabupaten);
    ALTER TABLE sekolah ADD COLUMN IF NOT EXISTS row_fp TEXT;
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS status_sinkronisasi (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      offset_terakhir INTEGER NOT NULL DEFAULT 0,
      waktu_selesai_terakhir TIMESTAMPTZ
    );
    INSERT INTO status_sinkronisasi (id, offset_terakhir)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function fetchDataAndInsert() {
  await client.connect();
  console.log("Terhubung ke database Neon.");

  await ensureSchema();
  console.log("Skema database siap.");

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

      if (!dataList || dataList.length === 0) {
        hasMoreData = false;
        console.log("🎉 SINKRONISASI SELESAI! Semua data telah dicek.");

        await client.query(`
          UPDATE status_sinkronisasi
          SET offset_terakhir = 0, waktu_selesai_terakhir = NOW()
          WHERE id = 1;
        `);
        break;
      }

      let dilewati = 0;
      let tanpaNpsn = 0;

      for (const item of dataList) {
        const npsn = item.npsn;
        if (!npsn) {
          tanpaNpsn++;
          continue;
        }

        const rowFp = buildRowFingerprint(item);
        const values = [
          npsn,
          item.nama ?? '',
          item.bentukPendidikan ?? null,
          item.bentukPendidikanGroup ?? null,
          item.jenisPendidikan ?? null,
          item.statusSatuanPendidikan ?? null,
          item.jenjangPendidikan ?? null,
          item.pembina ?? null,
          item.jalurPendidikan ?? null,
          item.namaDesa ?? null,
          item.namaKecamatan ?? null,
          item.namaKabupaten ?? null,
          item.namaProvinsi ?? null,
          item.alamatJalan ?? null,
          rowFp,
        ];

        const res = await client.query(UPSERT_SEKOLAH, values);
        if (res.rowCount === 0) {
          dilewati++;
        }
      }

      console.log(`Offset ${offset}: ${dataList.length} baris API, ${dilewati} diskip (fingerprint sama), ${tanpaNpsn} tanpa NPSN.`);

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
