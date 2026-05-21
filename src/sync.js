import { neon } from '@neondatabase/serverless';

const API_BASE =
  'https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/360';
const LIMIT = 20;
const INTERVAL_CATAT_WAKTU_MS = 30 * 60 * 1000;

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildRowFingerprint(item) {
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
  return sha256Hex(JSON.stringify(payload));
}

async function upsertSekolah(sql, item, rowFp) {
  await sql`
    INSERT INTO sekolah (
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp
    ) VALUES (
      ${item.npsn},
      ${item.nama ?? ''},
      ${item.bentukPendidikan ?? null},
      ${item.bentukPendidikanGroup ?? null},
      ${item.jenisPendidikan ?? null},
      ${item.statusSatuanPendidikan ?? null},
      ${item.jenjangPendidikan ?? null},
      ${item.pembina ?? null},
      ${item.jalurPendidikan ?? null},
      ${item.namaDesa ?? null},
      ${item.namaKecamatan ?? null},
      ${item.namaKabupaten ?? null},
      ${item.namaProvinsi ?? null},
      ${item.alamatJalan ?? null},
      ${rowFp}
    )
    ON CONFLICT (npsn) DO UPDATE SET
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
}

async function ensureSchema(sql) {
  await sql`
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
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sekolah_nama ON sekolah (nama)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sekolah_kabupaten ON sekolah (nama_kabupaten)`;
  await sql`ALTER TABLE sekolah ADD COLUMN IF NOT EXISTS row_fp TEXT`;
  await sql`
    CREATE TABLE IF NOT EXISTS status_sinkronisasi (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      offset_terakhir INTEGER NOT NULL DEFAULT 0,
      waktu_selesai_terakhir TIMESTAMPTZ
    )
  `;
  await sql`
    INSERT INTO status_sinkronisasi (id, offset_terakhir)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING
  `;
}

async function catatWaktuSinkronTerakhir(sql, state, paksa = false) {
  const sekarang = Date.now();
  if (!paksa && sekarang - state.waktuTerakhirDicatat < INTERVAL_CATAT_WAKTU_MS) {
    return state.waktuTerakhirDicatat;
  }
  await sql`UPDATE status_sinkronisasi SET waktu_selesai_terakhir = NOW() WHERE id = 1`;
  return sekarang;
}

async function syncBatch(sql, dataList) {
  const prepared = [];
  let tanpaNpsn = 0;

  for (const item of dataList) {
    if (!item.npsn) {
      tanpaNpsn++;
      continue;
    }
    prepared.push({
      item,
      npsn: item.npsn,
      rowFp: await buildRowFingerprint(item),
    });
  }

  if (prepared.length === 0) {
    return { baru: 0, diperbarui: 0, tidakBerubah: 0, tanpaNpsn };
  }

  const npsnList = prepared.map((p) => p.npsn);
  const rows = await sql`SELECT npsn, row_fp FROM sekolah WHERE npsn = ANY(${npsnList}::text[])`;
  const existing = new Map(rows.map((r) => [r.npsn, r.row_fp]));

  let baru = 0;
  let diperbarui = 0;
  let tidakBerubah = 0;

  for (const { item, npsn, rowFp } of prepared) {
    const prevFp = existing.get(npsn);
    if (prevFp === rowFp) {
      tidakBerubah++;
      continue;
    }

    await upsertSekolah(sql, item, rowFp);
    if (prevFp === undefined) {
      baru++;
    } else {
      diperbarui++;
    }
  }

  return { baru, diperbarui, tidakBerubah, tanpaNpsn };
}

/**
 * Satu invokasi Worker: proses batch sampai habis waktu, simpan offset di Neon.
 */
export async function runSync(env, { mulaiDariAwal = false, maxDurationMs = 28000 } = {}) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL belum diatur di secrets Worker.');
  }

  const sql = neon(env.DATABASE_URL);
  const logs = [];
  const log = (msg) => logs.push(msg);

  await ensureSchema(sql);
  log('Skema database siap.');

  let offset;
  if (mulaiDariAwal) {
    await sql`UPDATE status_sinkronisasi SET offset_terakhir = 0 WHERE id = 1`;
    offset = 0;
    log('Mulai dari awal (offset 0).');
  } else {
    const rows = await sql`SELECT offset_terakhir FROM status_sinkronisasi WHERE id = 1`;
    offset = parseInt(rows[0]?.offset_terakhir, 10) || 0;
    log(`Melanjutkan dari offset: ${offset}`);
  }

  const startedAt = Date.now();
  let waktuTerakhirDicatat = await catatWaktuSinkronTerakhir(sql, { waktuTerakhirDicatat: 0 }, true);

  let batches = 0;
  let totalBaru = 0;
  let totalDiperbarui = 0;
  let totalTidakBerubah = 0;
  let selesai = false;
  let alasanBerhenti = 'waktu_habis';

  while (Date.now() - startedAt < maxDurationMs) {
    const url = `${API_BASE}?limit=${LIMIT}&offset=${offset}`;
    log(`Mengecek API offset ${offset}...`);

    let dataList;
    try {
      const response = await fetch(url);
      const result = await response.json();
      dataList = result.data;
    } catch (err) {
      log(`Error API: ${err.message}`);
      alasanBerhenti = 'error_api';
      break;
    }

    if (!dataList || dataList.length === 0) {
      await sql`
        UPDATE status_sinkronisasi
        SET offset_terakhir = 0, waktu_selesai_terakhir = NOW()
        WHERE id = 1
      `;
      selesai = true;
      alasanBerhenti = 'selesai';
      log('Sinkronisasi selesai 100%. Offset direset ke 0.');
      break;
    }

    const stats = await syncBatch(sql, dataList);
    totalBaru += stats.baru;
    totalDiperbarui += stats.diperbarui;
    totalTidakBerubah += stats.tidakBerubah;

    log(
      `Offset ${offset}: ${dataList.length} dari API — ` +
        `${stats.tidakBerubah} tidak berubah, ${stats.baru} baru, ${stats.diperbarui} diperbarui.`
    );

    offset += LIMIT;
    await sql`UPDATE status_sinkronisasi SET offset_terakhir = ${offset} WHERE id = 1`;
    waktuTerakhirDicatat = await catatWaktuSinkronTerakhir(sql, { waktuTerakhirDicatat });
    batches++;

    if (stats.baru > 0 || stats.diperbarui > 0) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  if (!selesai) {
    waktuTerakhirDicatat = await catatWaktuSinkronTerakhir(sql, { waktuTerakhirDicatat }, true);
    log(`Berhenti (${alasanBerhenti}). Offset tersimpan: ${offset}. Cron berikutnya melanjutkan.`);
  }

  return {
    ok: true,
    selesai,
    alasanBerhenti,
    offsetBerikutnya: selesai ? 0 : offset,
    batches,
    totalBaru,
    totalDiperbarui,
    totalTidakBerubah,
    durasiDetik: Math.round((Date.now() - startedAt) / 1000),
    logs,
  };
}
