import { PowerSyncDatabase } from '@powersync/node';
import { AppSchema, createConnector, installPowerSyncScreenIndexes } from '../src/adapters/powersync-runner.ts';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
const [mode, endpoint, seconds='35']=process.argv.slice(2);
const dir=await mkdtemp(join(process.cwd(),'.tmp/powersync-probe-'));
const started=performance.now();
const emit=(event:string,data:unknown)=>console.log(JSON.stringify({mode,atMs:performance.now()-started,event,data}));
const db=new PowerSyncDatabase({schema:AppSchema,database:{dbFilename:join(dir,'db.sqlite')},logger:{log:({level,message,error})=>{if(level>=40)emit('error',{level,message,error:String(error??'')});}}});
await db.init();await installPowerSyncScreenIndexes(db);emit('initialized',{});
await db.connect(createConnector('org-1-user-1',{syncBaseUrl:endpoint,appBaseUrl:'http://127.0.0.1:3218'}));emit('connected',{});
let timer=setInterval(async()=>{const s=db.currentStatus;emit('progress',{connected:s.connected,hasSynced:s.hasSynced,downloading:s.downloading,progress:s.downloadProgress,rows:(await db.getAll('select count(*) n from tasks'))[0]});},5000);
try {await db.waitForStatus(s=>s.hasSynced===true,AbortSignal.timeout(Number(seconds)*1000));emit('firstSync',{rows:(await db.getAll('select count(*) n from tasks'))[0]});}catch(error){emit('timeout',{error:String(error)});}
clearInterval(timer);await db.disconnect();await db.close();emit('closed',{});
