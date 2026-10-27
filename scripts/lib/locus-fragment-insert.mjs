// PostgreSQL 18 uuidv7 for this bulk import only. The standard repository still
// validates ownership, page locators, fragment identity and all FK constraints.
// ID-first indexes on the existing large corpus otherwise cause random disk reads.
export function orderedFragmentInsert(sql) {
  const prefix='INSERT INTO evidence_fragment (tender_id, contract_id,';
  if(!sql.startsWith(prefix))throw new Error('unexpected_fragment_insert_shape');
  const rows=[...sql.matchAll(/\(\$1, \$4, 'recognition_run'/g)].length;
  if(rows<1||rows>100)throw new Error('unexpected_fragment_row_shape');
  return sql.replace(prefix,'INSERT INTO evidence_fragment (id, tender_id, contract_id,').replaceAll("($1, $4, 'recognition_run'","(uuidv7(), $1, $4, 'recognition_run'");
}
