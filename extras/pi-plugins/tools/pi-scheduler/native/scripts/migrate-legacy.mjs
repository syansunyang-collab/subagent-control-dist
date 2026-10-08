import core from '../extensions/scheduler/core.cjs';
import legacy from '../extensions/scheduler/legacy.cjs';
const args = process.argv.slice(2);
function option(name, fallback) { const i=args.indexOf(name); if(i<0)return fallback; if(!args[i+1] || args[i+1].startsWith('--'))throw new Error(`${name} requires a path`); return args[i+1]; }
const legacyFile=option('--legacy',legacy.defaultLegacyFile());
const stateFile=option('--state',core.resolveStateFile());
const input=legacy.readLegacyState(legacyFile);
if(!input.ok)throw new Error(input.error);
const plan=legacy.planMigration({legacyTasks:input.tasks,legacyFile,stateFile});
console.log(legacy.formatMigrationPlan(plan));
if(args.includes('--apply'))console.log(JSON.stringify(legacy.applyMigration(plan,{store:core.createStateStore({stateFile})}),null,2));
