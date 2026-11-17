import { NextResponse } from 'next/server';
import { getPool } from '../../../../lib/newDesigns.js';
import { ALL_PRODUCT_TYPES } from '../../../../lib/handoff.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 26;

// POST /api/new-designs/upload
// Chunked intake from the browser after it has diffed the catalog export.
// Actions:
//   begin   {label, filename}                 -> {uploadId}
//   designs {uploadId, rows:[{design_key, s6_product_id, title, image_url,
//            artist_name, product_type, handle}]}   APPEND-only into products
//            (idempotent: skips design_keys already present — same contract
//            as import-pillows.mjs; NEVER truncates)
//   pages   {uploadId, rows:[{page_id, handle, product_type, design_key}]}
//   finish  {uploadId, totalDesigns, totalPages, unknownTypes:[{type,pages}]}

// Product types the curation tool offers — derived from the canonical list in
// lib/handoff.js so the two can never drift. (This used to be imported from
// lib/newDesigns.js, which never exported it: the value was undefined, so the
// design_formats insert below silently matched no rows.)
const OFFERED_TYPES = ALL_PRODUCT_TYPES.map(t => t.type);

// Register nd_pages rows (offered types only) in design_formats so the designs
// are recommendable. uploadId = null means every upload (one-time backfill).
// URL falls back to the Shopify handle path, which the front end already
// expands to the full society6.com link. Idempotent.
async function registerFormats(pool, uploadId) {
  const res = await pool.query(
    `INSERT INTO design_formats (design_key, product_type, url, image_url)
     SELECT DISTINCT ON (design_key, product_type)
            design_key, product_type,
            COALESCE(NULLIF(url, ''), '/products/' || handle),
            NULLIF(image_url, '')
     FROM nd_pages
     WHERE ($1::int IS NULL OR upload_id = $1) AND product_type = ANY($2::text[])
     ORDER BY design_key, product_type, upload_id DESC
     ON CONFLICT (design_key, product_type) DO UPDATE SET
       image_url = COALESCE(NULLIF(design_formats.image_url, ''), EXCLUDED.image_url),
       url       = COALESCE(NULLIF(design_formats.url, ''), EXCLUDED.url)
     RETURNING (xmax = 0) AS inserted`,
    [uploadId, OFFERED_TYPES]
  );
  return { touched: res.rowCount, added: res.rows.filter(r => r.inserted).length };
}

// Column candidates, same spirit as import-pillows.mjs MAP: adapt to whatever
// columns the products table actually has.
const MAP = {
  design_key: ['design_key'],
  s6_product_id: ['s6_product_id'],
  title: ['title'],
  image_url: ['image_url'],
  artist_name: ['artist_name', 'vendor'],
  product_type: ['product_type', 'type'],
  handle: ['product_handle', 'handle'],
  description_status: ['description_status'],
};

// Idempotent, once per lambda: newer columns on nd_pages + the curation
// tool's design_formats table (same shape build_design_formats.mjs creates,
// but never dropped — we only ever append).
let _auxReady = false;
async function ensureAux(pool) {
  if (_auxReady) return;
  await pool.query(`ALTER TABLE nd_pages ADD COLUMN IF NOT EXISTS url text`);
  await pool.query(`ALTER TABLE nd_pages ADD COLUMN IF NOT EXISTS image_url text`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS design_formats (
      design_key   text NOT NULL,
      product_type text NOT NULL,
      url          text,
      image_url    text,
      PRIMARY KEY (design_key, product_type)
    )`);
  _auxReady = true;
}

let _mapping = null;
async function getMapping(pool) {
  if (_mapping) return _mapping;
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'products'`
  );
  const tableCols = new Set(rows.map(r => r.column_name));
  const mapping = [];
  for (const [field, cands] of Object.entries(MAP)) {
    const col = cands.find(c => tableCols.has(c));
    if (col) mapping.push({ field, col });
  }
  _mapping = mapping;
  return mapping;
}

export async function POST(request) {
  try {
    const pool = getPool();
    const body = await request.json();
    const { action } = body;

    if (action === 'begin') {
      const { rows: [row] } = await pool.query(
        `INSERT INTO nd_uploads (label, filename) VALUES ($1, $2) RETURNING id`,
        [body.label || null, body.filename || null]
      );
      return NextResponse.json({ uploadId: row.id });
    }

    if (action === 'designs') {
      const rows = body.rows || [];
      if (!rows.length) return NextResponse.json({ inserted: 0, skipped: 0 });
      const mapping = await getMapping(pool);

      // idempotency: skip keys already present (import-pillows.mjs contract)
      const keys = rows.map(r => r.design_key);
      const { rows: existRows } = await pool.query(
        `SELECT design_key FROM products WHERE design_key = ANY($1::text[])`, [keys]
      );
      const existing = new Set(existRows.map(r => r.design_key));
      const fresh = rows.filter(r => !existing.has(r.design_key));

      // Backfill: a design imported by an EARLIER upload without an image
      // (export missing Image Src) keeps its row, but if this upload now
      // carries an image for it, adopt it. Never overwrites a real image.
      const backfill = rows.filter(r =>
        existing.has(r.design_key) && (r.image_url || '').trim());
      if (backfill.length) {
        await pool.query(
          `UPDATE products p
           SET image_url = v.image_url, updated_at = now()
           FROM (SELECT unnest($1::text[]) AS design_key,
                        unnest($2::text[]) AS image_url) v
           WHERE p.design_key = v.design_key
             AND COALESCE(p.image_url, '') = ''`,
          [backfill.map(r => r.design_key), backfill.map(r => r.image_url.trim())]
        );
      }

      // Rows can already hold the same s6_product_id in two cases:
      //   1. legacy curation rows (design_key NULL — invisible to the diff)
      //   2. designs keyed under OLDER derivation rules (design_key set, but
      //      stale — e.g. keyed before the rectangular-pillow/sheet-set slugs
      //      existed). The current derivation is canonical.
      // On collision, RE-KEY the row to the canonical design_key. Copy already
      // written on that row stays attached (enrichment_results joins by
      // product_id), so a described design becomes instantly available under
      // its new key. Only rows without copy get queued as pending.
      let inserted = 0;
      const cols = mapping.map(m => m.col);
      const hasConflictCols = cols.includes('s6_product_id') && cols.includes('design_key');
      const conflictClause = hasConflictCols ? `
        ON CONFLICT (s6_product_id) DO UPDATE SET
          design_key   = EXCLUDED.design_key,
          product_type = CASE WHEN products.design_key IS NULL THEN EXCLUDED.product_type ELSE products.product_type END,
          image_url    = CASE WHEN COALESCE(products.image_url, '') = '' THEN EXCLUDED.image_url ELSE products.image_url END,
          description_status = CASE
            WHEN products.description_status IS DISTINCT FROM 'described'
            THEN EXCLUDED.description_status
            ELSE products.description_status
          END` : '';
      const BATCH = 250;
      for (let i = 0; i < fresh.length; i += BATCH) {
        const chunk = fresh.slice(i, i + BATCH);
        const values = [];
        const tuples = chunk.map((r, ri) => {
          const ph = mapping.map((m, ci) => {
            values.push(m.field === 'description_status' ? 'pending' : (r[m.field] ?? null));
            return `$${ri * cols.length + ci + 1}`;
          });
          return `(${ph.join(',')})`;
        });
        await pool.query(
          `INSERT INTO products (${cols.join(',')}) VALUES ${tuples.join(',')}${conflictClause}`,
          values
        );
        inserted += chunk.length;
      }
      return NextResponse.json({ inserted, skipped: rows.length - fresh.length });
    }

    if (action === 'pages') {
      const { uploadId } = body;
      const rows = body.rows || [];
      if (!uploadId) return NextResponse.json({ error: 'uploadId required' }, { status: 400 });
      if (!rows.length) return NextResponse.json({ inserted: 0 });
      await ensureAux(pool);
      let inserted = 0;
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const values = [];
        const tuples = chunk.map((r, ri) => {
          values.push(uploadId, r.page_id ?? null, r.handle, r.product_type, r.design_key,
            r.url ?? null, r.image_url ?? null);
          const b = ri * 7;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
        });
        const res = await pool.query(
          `INSERT INTO nd_pages (upload_id, page_id, handle, product_type, design_key, url, image_url)
           VALUES ${tuples.join(',')} ON CONFLICT (upload_id, handle) DO NOTHING`,
          values
        );
        inserted += res.rowCount;
      }
      return NextResponse.json({ inserted });
    }

    if (action === 'finish') {
      const { uploadId, totalDesigns = 0, totalPages = 0, unknownTypes = [] } = body;
      await pool.query(
        `UPDATE nd_uploads SET total_designs = $2, total_pages = $3, unknown_types = $4 WHERE id = $1`,
        [uploadId, totalDesigns, totalPages, JSON.stringify(unknownTypes)]
      );
      // Feed the curation tool: register this upload's pages (offered types
      // only) in design_formats so new designs are recommendable immediately.
      await ensureAux(pool);
      const fmt = await registerFormats(pool, uploadId);
      return NextResponse.json({ ok: true, curationFormatsAdded: fmt.added });
    }

    // One-time repair for uploads finished while OFFERED_TYPES was undefined:
    // re-registers every upload's pages. Safe to run more than once.
    if (action === 'backfill-formats') {
      await ensureAux(pool);
      const fmt = await registerFormats(pool, null);
      return NextResponse.json({ ok: true, ...fmt });
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    console.error('new-designs upload error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
