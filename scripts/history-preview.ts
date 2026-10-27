// Read-only inspection of a legacy report. Does not connect to a DB or execute HTML.
import { readFile,stat } from 'node:fs/promises';
import { prepareLegacyHistory,readLegacyHistory } from '@kontur/core';
const report=process.argv[2];
if(!report){console.error('Использование: node scripts/history-preview.ts <HTML или JSON>');process.exit(2);}
if((await stat(report)).size>40*1024*1024)throw new Error('Отчёт больше 40 МБ');
const source=readLegacyHistory(await readFile(report,'utf8'));
console.log(JSON.stringify({sha256:source.sha256,folders:source.folders.map(folder=>{
  const data=prepareLegacyHistory(source,folder.id);
  return {externalFolderId:folder.id,folderName:folder.name,records:data.records.length,files:data.files.length,complete:data.complete,observedAt:data.observedAt};
})},null,2));
