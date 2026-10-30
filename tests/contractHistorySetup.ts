import pg from 'pg';
import {ensureRoles} from '../packages/db/src/index.ts';
export default async()=>{
 const url=process.env.KONTUR_TEST_ADMIN_URL;
 if(!url||new URL(url).port!=='55467')throw Error('Dedicated test cluster is required');
 const client=new pg.Client({connectionString:url});await client.connect();
 try{await ensureRoles(client);}finally{await client.end();}
};
