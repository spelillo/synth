#!/usr/bin/env node
// One-off script: uploads the university dataset library template's CSVs
// to the private 'dataset-library' Storage bucket and inserts its metadata
// rows (dataset_library_templates/tables/relationships). Run manually,
// once, after applying supabase/migrations/20260920000000_dataset_library.sql
// and creating the 'dataset-library' bucket (Storage -> New bucket ->
// name it exactly "dataset-library" -> Public: OFF).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-dataset-library.js
//
// Idempotent: re-running skips creating a duplicate template if one with
// the same vertical already exists (deletes and recreates its
// tables/relationships/storage objects instead, so edits to this script
// or the source CSVs can be re-applied by just running it again).

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, '..', 'supabase', 'seed', 'dataset-library', 'university');

const VERTICAL = 'university';
const TEMPLATE_NAME = 'State University';
const TEMPLATE_DESCRIPTION = 'Students, courses, staff, and buildings — practice real joins across a small university dataset.';

const TABLES = [
  { table_name: 'students', file: 'students.csv' },
  { table_name: 'courses', file: 'courses.csv' },
  { table_name: 'staff', file: 'staff.csv' },
  { table_name: 'buildings', file: 'buildings.csv' },
];

// Column names here MUST match what synth.html's sanitizeColumnName()
// actually produces when the CSV is loaded (`header.trim().replace(/\s+/g, '_')`
// — every run of whitespace becomes one underscore), NOT the raw CSV
// header text. Found live: the original version of this file used the raw
// headers ("Staff ID" with a space), which silently failed to match the
// real "Staff_ID" column — two of the three relationships ("College", a
// single word, unaffected by the space-to-underscore rule) rendered fine
// and masked the bug until a real end-to-end load was tested.
const RELATIONSHIPS = [
  { from_table: 'courses', from_column: 'Staff_ID', to_table: 'staff', to_column: 'Staff_ID' },
  { from_table: 'students', from_column: 'College', to_table: 'staff', to_column: 'College' },
  { from_table: 'students', from_column: 'College', to_table: 'buildings', to_column: 'College' },
];

function csvMeta(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const columns = lines[0].split(',');
  return { columns, row_count: lines.length - 1 };
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.');
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: existing, error: existingError } = await supabase
    .from('dataset_library_templates')
    .select('id')
    .eq('vertical', VERTICAL)
    .maybeSingle();
  if (existingError) throw existingError;

  let templateId;
  if (existing) {
    templateId = existing.id;
    console.log(`Existing "${VERTICAL}" template found (${templateId}) — clearing its tables/relationships before re-seeding.`);
    await supabase.from('dataset_library_tables').delete().eq('template_id', templateId);
    await supabase.from('dataset_library_relationships').delete().eq('template_id', templateId);
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from('dataset_library_templates')
      .insert({ vertical: VERTICAL, name: TEMPLATE_NAME, description: TEMPLATE_DESCRIPTION })
      .select('id')
      .single();
    if (insertError) throw insertError;
    templateId = inserted.id;
    console.log(`Created "${VERTICAL}" template (${templateId}).`);
  }

  for (const t of TABLES) {
    const filePath = join(SEED_DIR, t.file);
    const text = readFileSync(filePath, 'utf8');
    const { columns, row_count } = csvMeta(text);
    const storagePath = `${VERTICAL}/${t.file}`;

    const { error: uploadError } = await supabase.storage
      .from('dataset-library')
      .upload(storagePath, Buffer.from(text, 'utf8'), { upsert: true, contentType: 'text/csv' });
    if (uploadError) throw uploadError;
    console.log(`Uploaded ${storagePath} (${row_count} rows, ${columns.length} columns).`);

    const { error: tableRowError } = await supabase
      .from('dataset_library_tables')
      .insert({ template_id: templateId, table_name: t.table_name, storage_path: storagePath, row_count, columns });
    if (tableRowError) throw tableRowError;
  }

  const { error: relError } = await supabase
    .from('dataset_library_relationships')
    .insert(RELATIONSHIPS.map((r) => ({ ...r, template_id: templateId })));
  if (relError) throw relError;

  console.log(`Done. Template "${TEMPLATE_NAME}" (${templateId}) is ready — enable it for an org from Account Settings.`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
