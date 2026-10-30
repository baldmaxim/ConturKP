import {readFile,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {importContractHistoryPlan,type IContractHistoryPlan} from '../packages/db/src/contractHistoryPlan.ts';
const args=process.argv.slice(2),value=(flag:string)=>args[args.indexOf(flag)+1];
if(!args.includes('--plan')||!args.includes('--actor'))throw Error('Usage: --plan private-plan.json --actor UUID [--apply] [--grant-creator] [--result private-result.json]');
const plan=JSON.parse(await readFile(value('--plan')!,'utf8')) as IContractHistoryPlan;
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
try{
 await db.query('BEGIN');
 const result=await importContractHistoryPlan(db,value('--actor')!,plan,args.includes('--grant-creator'));
 await db.query(args.includes('--apply')?'COMMIT':'ROLLBACK');
 const report={at:new Date().toISOString(),applied:args.includes('--apply'),...result};
 if(args.includes('--result'))await writeFile(value('--result')!,JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,contracts:report.contracts.length}));
}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
