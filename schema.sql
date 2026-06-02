-- Jalankan di Neon SQL Editor jika ingin setup manual (opsional; index.js juga membuat ini otomatis)

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

CREATE TABLE IF NOT EXISTS status_sinkronisasi (
  id SMALLINT PRIMARY KEY CHECK (id IN (1, 2)),
  bentuk_aktif TEXT,
  offset_terakhir INTEGER NOT NULL DEFAULT 0,
  waktu_selesai_terakhir TIMESTAMPTZ
);

INSERT INTO status_sinkronisasi (id, offset_terakhir)
VALUES (1, 0), (2, 0)
ON CONFLICT (id) DO NOTHING;
