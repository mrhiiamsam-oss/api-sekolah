export const VALID_BENTUK = [
  'tk', 'kb', 'sps', 'tpa', 'paudq', 'sd', 'smp', 'sma', 'smk', 'slb',
  'skb', 'pkbm', 'kursus', 'ra', 'mi', 'mts', 'ma',
  'smak', 'smptk', 'smtk', 'sdtk', 'spk-kb', 'spk-sd', 'spk-sma', 'spk-smp', 'spk-tk',
  'spm-ula', 'spm-ulya', 'spm-wustha', 'taman-seminari', 'pdf-ulya', 'pdf-wustha',
  'mak', 'mula-dhammasekha', 'nava-dhammasekha', 'uttama-dhammasekha', 'pondok-pesantren',
  'smag-k'
];

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

/** 
 * Memproses batch data (array dari belajar.id) dan memasukkannya ke D1 
 */
export async function syncBatch(db, dataList) {
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

  // Karena SQLite tidak memiliki ANY($1) untuk array, kita buat query dinamis
  const placeholders = prepared.map(() => '?').join(',');
  const npsnList = prepared.map((p) => p.npsn);
  
  const { results: rows } = await db.prepare(
    `SELECT npsn, row_fp FROM sekolah WHERE npsn IN (${placeholders})`
  ).bind(...npsnList).all();

  const existing = new Map((rows || []).map((r) => [r.npsn, r.row_fp]));

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
    // D1 merekomendasikan DB.batch() untuk insert massal
    const statements = toUpsert.map(({ item, rowFp }) => {
      return db.prepare(`
        INSERT INTO sekolah (
          npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
          status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
          nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp, migrated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 hours'))
        ON CONFLICT(npsn) DO UPDATE SET
          nama = excluded.nama,
          bentuk_pendidikan = excluded.bentuk_pendidikan,
          bentuk_pendidikan_group = excluded.bentuk_pendidikan_group,
          jenis_pendidikan = excluded.jenis_pendidikan,
          status_satuan_pendidikan = excluded.status_satuan_pendidikan,
          jenjang_pendidikan = excluded.jenjang_pendidikan,
          pembina = excluded.pembina,
          jalur_pendidikan = excluded.jalur_pendidikan,
          nama_desa = excluded.nama_desa,
          nama_kecamatan = excluded.nama_kecamatan,
          nama_kabupaten = excluded.nama_kabupaten,
          nama_provinsi = excluded.nama_provinsi,
          alamat_jalan = excluded.alamat_jalan,
          row_fp = excluded.row_fp,
          migrated_at = datetime('now', '+7 hours')
      `).bind(
        item.npsn,
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
        rowFp
      );
    });

    await db.batch(statements);
  }

  return { baru, diperbarui, tidakBerubah, tanpaNpsn };
}
