import {test} from 'node:test';import assert from 'node:assert/strict';import {classifyCustomSignal} from '../src/services/customSignalExtraction.mjs';
const definition={rule:'A customer needs a security review',examples:''};const claim={value:{content:'We need a security review before signing.'}};
const adapters=(output)=>({gate:async()=>{},generate:async()=>({content:[{type:'text',text:JSON.stringify(output)}]}),meter:async()=>{}});
test('custom signals require a verbatim grounded quote',async()=>{assert.deepEqual(await classifyCustomSignal(definition,claim,adapters({matched:true,quote:'security review before signing'})),{quote:'security review before signing'});await assert.rejects(classifyCustomSignal(definition,claim,adapters({matched:true,quote:'budget approved today'})),/grounded evidence/);});
test('unmatched evidence produces no signal',async()=>assert.equal(await classifyCustomSignal(definition,claim,adapters({matched:false,quote:''})),null));
test('custom extraction blocks paid work at credit gate',async()=>{let generated=false;await assert.rejects(classifyCustomSignal(definition,claim,{gate:async()=>{throw new Error('credits');},generate:async()=>{generated=true;},meter:async()=>{}}),/credits/);assert.equal(generated,false);});
test('active selection criteria are scoped to one workspace',async()=>{
 const {customSignalRulesForWorkspace}=await import('../dist/db/customSignals.mjs');
 const rows=[{workspace_id:'a',active:true,id:'a-rule'},{workspace_id:'b',active:true,id:'b-rule'},{workspace_id:'a',active:false,id:'paused'},{workspace_id:'a',active:true,id:'archived',archived_at:'2026-10-14T00:00:00Z'}];
 const sb={from(){const filters=[];return {select(){return this;},order(){return this;},eq(k,v){filters.push(r=>r[k]===v);return this;},is(k,v){filters.push(r=>(r[k]??null)===v);return this;},then(resolve){return Promise.resolve({data:rows.filter(r=>filters.every(f=>f(r))),error:null}).then(resolve);}};}};
 assert.deepEqual((await customSignalRulesForWorkspace(sb,'a')).map(r=>r.id),['a-rule']);
 assert.deepEqual((await customSignalRulesForWorkspace(sb,'b')).map(r=>r.id),['b-rule']);
});
