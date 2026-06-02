import { neon } from '@neondatabase/serverless';

const API_BASE =
  'https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/360';
const LIMIT = 20;
const INTERVAL_CATAT_WAKTU_MS = 60 * 60 * 1000;
/** Cloudflare Free: max 50 subrequest/invokasi. ~3–4 per batch → aman di 10 batch.
 * Catatan: API hanya merespon maksimal 20 data, jadi jangan naikkan LIMIT. */
const DEFAULT_MAX_BATCHES = 10;
const DEFAULT_MAX_SUBREQUESTS = 45;

const VALID_BENTUK = ['tk', 'kb', 'sps', 'tpa', 'paudq', 'sd', 'smp', 'sma', 'smk', 'slb', 'skb', 'pkbm', 'kursus', 'ra', 'mi', 'mts', 'ma'];

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

/** Satu query untuk semua baris yang berubah di batch (bukan 20 query terpisah). */
async function bulkUpsertSekolah(sql, toUpsert) {
  if (toUpsert.length === 0) return;

  const npsn = [];
  const nama = [];
  const bentuk_pendidikan = [];
  const bentuk_pendidikan_group = [];
  const jenis_pendidikan = [];
  const status_satuan_pendidikan = [];
  const jenjang_pendidikan = [];
  const pembina = [];
  const jalur_pendidikan = [];
  const nama_desa = [];
  const nama_kecamatan = [];
  const nama_kabupaten = [];
  const nama_provinsi = [];
  const alamat_jalan = [];
  const row_fp = [];

  for (const { item, rowFp } of toUpsert) {
    npsn.push(item.npsn);
    nama.push(item.nama ?? '');
    bentuk_pendidikan.push(item.bentukPendidikan ?? null);
    bentuk_pendidikan_group.push(item.bentukPendidikanGroup ?? null);
    jenis_pendidikan.push(item.jenisPendidikan ?? null);
    status_satuan_pendidikan.push(item.statusSatuanPendidikan ?? null);
    jenjang_pendidikan.push(item.jenjangPendidikan ?? null);
    pembina.push(item.pembina ?? null);
    jalur_pendidikan.push(item.jalurPendidikan ?? null);
    nama_desa.push(item.namaDesa ?? null);
    nama_kecamatan.push(item.namaKecamatan ?? null);
    nama_kabupaten.push(item.namaKabupaten ?? null);
    nama_provinsi.push(item.namaProvinsi ?? null);
    alamat_jalan.push(item.alamatJalan ?? null);
    row_fp.push(rowFp);
  }

  await sql`
    INSERT INTO sekolah (
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp
    )
    SELECT * FROM UNNEST(
      ${npsn}::text[],
      ${nama}::text[],
      ${bentuk_pendidikan}::text[],
      ${bentuk_pendidikan_group}::text[],
      ${jenis_pendidikan}::text[],
      ${status_satuan_pendidikan}::text[],
      ${jenjang_pendidikan}::text[],
      ${pembina}::text[],
      ${jalur_pendidikan}::text[],
      ${nama_desa}::text[],
      ${nama_kecamatan}::text[],
      ${nama_kabupaten}::text[],
      ${nama_provinsi}::text[],
      ${alamat_jalan}::text[],
      ${row_fp}::text[]
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

/** Hanya jika ENSURE_SCHEMA=1 (setup awal). Menghindari 5+ subrequest tiap run. */
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
    );
    CREATE INDEX IF NOT EXISTS idx_sekolah_nama ON sekolah (nama);
    CREATE INDEX IF NOT EXISTS idx_sekolah_kabupaten ON sekolah (nama_kabupaten);
    ALTER TABLE sekolah ADD COLUMN IF NOT EXISTS row_fp TEXT;
    CREATE TABLE IF NOT EXISTS status_sinkronisasi (
      id SMALLINT PRIMARY KEY,
      offset_terakhir INTEGER NOT NULL DEFAULT 0,
      waktu_selesai_terakhir TIMESTAMPTZ
    );
    ALTER TABLE status_sinkronisasi DROP CONSTRAINT IF EXISTS status_sinkronisasi_id_check;
    ALTER TABLE status_sinkronisasi ADD CONSTRAINT status_sinkronisasi_id_check CHECK (id IN (1, 2));
    ALTER TABLE status_sinkronisasi ADD COLUMN IF NOT EXISTS bentuk_aktif TEXT;
    INSERT INTO status_sinkronisasi (id, offset_terakhir, bentuk_aktif)
    VALUES (1, 0, 'tk'), (2, 0, 'tk')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function catatWaktuSinkronTerakhir(sql, state, paksa = false) {
  const sekarang = Date.now();
  if (!paksa && sekarang - state.waktuTerakhirDicatat < INTERVAL_CATAT_WAKTU_MS) {
    return { waktuTerakhirDicatat: state.waktuTerakhirDicatat, subrequests: 0 };
  }
  await sql`UPDATE status_sinkronisasi SET waktu_selesai_terakhir = NOW() WHERE id = 1`;
  return { waktuTerakhirDicatat: sekarang, subrequests: 1 };
}

async function syncBatch(sql, dataList) {
  let subrequests = 0;
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
    return { baru: 0, diperbarui: 0, tidakBerubah: 0, tanpaNpsn, subrequests: 0 };
  }

  const npsnList = prepared.map((p) => p.npsn);
  const rows = await sql`SELECT npsn, row_fp FROM sekolah WHERE npsn = ANY(${npsnList}::text[])`;
  subrequests += 1;
  const existing = new Map(rows.map((r) => [r.npsn, r.row_fp]));

  const toUpsert = [];
  let baru = 0;
  let diperbarui = 0;
  let tidakBerubah = 0;

  for (const entry of prepared) {
    const prevFp = existing.get(entry.npsn);
    if (prevFp === entry.rowFp) {
      tidakBerubah++;
      continue;
    }
    toUpsert.push(entry);
    if (prevFp === undefined) {
      baru++;
    } else {
      diperbarui++;
    }
  }

  if (toUpsert.length > 0) {
    await bulkUpsertSekolah(sql, toUpsert);
    subrequests += 1;
  }

  return { baru, diperbarui, tidakBerubah, tanpaNpsn, subrequests };
}

/**
 * Satu invokasi Worker: proses batch sampai habis waktu / subrequest, simpan offset di Neon.
 */
export async function runSync(env, { mulaiDariAwal = false, maxDurationMs = 28000 } = {}) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL belum diatur di secrets Worker.');
  }

  const maxBatches = parseInt(env.MAX_BATCHES || String(DEFAULT_MAX_BATCHES), 10);
  const maxSubrequests = parseInt(
    env.MAX_SUBREQUESTS || String(DEFAULT_MAX_SUBREQUESTS),
    10
  );

  const sql = neon(env.DATABASE_URL);
  const logs = [];
  const log = (msg) => logs.push(msg);
  let subrequests = 0;

  if (env.ENSURE_SCHEMA === '1') {
    await ensureSchema(sql);
    subrequests += 1;
    log('Skema database dicek (ENSURE_SCHEMA=1).');
  }

  let bentukAktif;
  let offset;
  if (mulaiDariAwal) {
    await sql`UPDATE status_sinkronisasi SET bentuk_aktif = 'tk', offset_terakhir = 0 WHERE id = 1`;
    subrequests += 1;
    bentukAktif = 'tk';
    offset = 0;
    log('Mulai dari awal (bentuk direset ke tk, offset direset ke 0).');
  } else {
    const rows = await sql`SELECT bentuk_aktif, offset_terakhir FROM status_sinkronisasi WHERE id = 1`;
    subrequests += 1;
    const row = rows[0];
    bentukAktif = row?.bentuk_aktif || 'tk';
    offset = parseInt(row?.offset_terakhir, 10) || 0;
    log(`Melanjutkan sinkronisasi [${bentukAktif.toUpperCase()}] dari offset: ${offset}`);
  }

  const startedAt = Date.now();
  let waktuTerakhirDicatat = 0;
  const waktuAwal = await catatWaktuSinkronTerakhir(sql, { waktuTerakhirDicatat: 0 }, true);
  waktuTerakhirDicatat = waktuAwal.waktuTerakhirDicatat;
  subrequests += waktuAwal.subrequests;

  let batches = 0;
  let totalBaru = 0;
  let totalDiperbarui = 0;
  let totalTidakBerubah = 0;
  let selesai = false;
  let alasanBerhenti = 'waktu_habis';

  while (
    Date.now() - startedAt < maxDurationMs &&
    batches < maxBatches &&
    subrequests < maxSubrequests
  ) {
    const url = `${API_BASE}?limit=${LIMIT}&offset=${offset}&bentukPendidikan=${bentukAktif}`;
    log(`Mengecek API [${bentukAktif.toUpperCase()}] offset ${offset}...`);

    let dataList;
    try {
      const response = await fetch(url);
      subrequests += 1;
      const result = await response.json();
      dataList = result.data;
    } catch (err) {
      log(`Error API: ${err.message}`);
      alasanBerhenti = 'error_api';
      break;
    }

    if (!dataList || dataList.length === 0) {
      const currentIndex = VALID_BENTUK.indexOf(bentukAktif);
      const nextIndex = currentIndex + 1;

      if (nextIndex < VALID_BENTUK.length) {
        bentukAktif = VALID_BENTUK[nextIndex];
        offset = 0;
        log(`➡️ Selesai untuk tipe sekolah ini. Pindah ke bentuk pendidikan berikutnya: [${bentukAktif.toUpperCase()}]`);
        await sql`UPDATE status_sinkronisasi SET bentuk_aktif = ${bentukAktif}, offset_terakhir = 0 WHERE id = 1`;
        subrequests += 1;
        continue;
      } else {
        await sql`
          UPDATE status_sinkronisasi
          SET bentuk_aktif = 'tk', offset_terakhir = 0, waktu_selesai_terakhir = NOW()
          WHERE id = 1
        `;
        subrequests += 1;
        selesai = true;
        alasanBerhenti = 'selesai';
        log('Sinkronisasi selesai 100%. Semua bentuk pendidikan disinkronkan.');
        break;
      }
    }

    const stats = await syncBatch(sql, dataList);
    subrequests += stats.subrequests;
    totalBaru += stats.baru;
    totalDiperbarui += stats.diperbarui;
    totalTidakBerubah += stats.tidakBerubah;

    log(
      `Offset ${offset} [${bentukAktif}]: ${dataList.length} dari API — ` +
        `${stats.tidakBerubah} tidak berubah, ${stats.baru} baru, ${stats.diperbarui} diperbarui.`
    );

    offset += LIMIT;
    await sql`UPDATE status_sinkronisasi SET offset_terakhir = ${offset} WHERE id = 1`;
    subrequests += 1;
    const waktu = await catatWaktuSinkronTerakhir(sql, { waktuTerakhirDicatat });
    waktuTerakhirDicatat = waktu.waktuTerakhirDicatat;
    subrequests += waktu.subrequests;
    batches++;

    if (subrequests >= maxSubrequests) {
      alasanBerhenti = 'batas_subrequest';
      log(`Mencapai batas subrequest (~${maxSubrequests}). Cron berikutnya melanjutkan.`);
      break;
    }
  }

  if (!selesai && alasanBerhenti === 'waktu_habis' && batches >= maxBatches) {
    alasanBerhenti = 'batas_batch';
    log(`Mencapai batas ${maxBatches} batch per invokasi. Cron berikutnya melanjutkan.`);
  }

  if (!selesai) {
    const waktu = await catatWaktuSinkronTerakhir(sql, { waktuTerakhirDicatat }, true);
    subrequests += waktu.subrequests;
    log(`Berhenti (${alasanBerhenti}). Offset tersimpan: ${offset} [${bentukAktif}].`);
  }

  return {
    ok: true,
    selesai,
    alasanBerhenti,
    offsetBerikutnya: selesai ? 0 : offset,
    bentukBerikutnya: selesai ? 'tk' : bentukAktif,
    batches,
    subrequests,
    totalBaru,
    totalDiperbarui,
    totalTidakBerubah,
    durasiDetik: Math.round((Date.now() - startedAt) / 1000),
    logs,
  };
}
