import {it,expect} from 'vitest';
import {mkdtemp,writeFile,stat,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openContractHistoryFile} from '../packages/storage/src/contractHistory.ts';
it('opens only an unchanged file inside the configured root',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contract-history-test-'));const path=join(root,'document.pdf');
 await writeFile(path,'first');const st=await stat(path,{bigint:true});const expected={size:st.size.toString(),mtime:st.mtimeNs.toString()};
 const opened=await openContractHistoryFile(root,'document.pdf',expected);
 let text='';for await(const chunk of opened.stream)text+=chunk.toString();expect(text).toBe('first');
 await writeFile(path,'second');
 await expect(openContractHistoryFile(root,'document.pdf',expected)).rejects.toThrow('history_source_changed');
 await expect(openContractHistoryFile(root,'..\\document.pdf',expected)).rejects.toThrow('history_unsafe_path');
});
it('rejects a junction to a different directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contract-history-test-'));const outside=await mkdtemp(join(tmpdir(),'contract-history-outside-'));
 await writeFile(join(outside,'secret.pdf'),'secret');const st=await stat(join(outside,'secret.pdf'),{bigint:true});
 await mkdir(join(root,'folder'));await symlink(outside,join(root,'folder','link'),'junction');
 await expect(openContractHistoryFile(root,'folder\\link\\secret.pdf',{size:st.size.toString(),mtime:st.mtimeNs.toString()})).rejects.toThrow('history_unsafe_path');
});
