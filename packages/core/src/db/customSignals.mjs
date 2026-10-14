import {revboxMembership,loadRevbox} from './revboxes.mjs';
import {filterDerivedForViewer,TEAM_VIEWER} from '../privacy/messagePrivacy.mjs';
import {signalCatalog} from '../services/signalCatalog.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
async function q(query){const {data,error}=await query;if(error)throw error;return data;}
// Workspace signals (GET-862). A definition belongs to the WORKSPACE: `revbox_id` only records the
// box it was proposed in. `key` is its stable handle (`custom.<key>` in the signal catalog and a
// job's trigger): derived from the name when not given, unique per workspace, never changed after
// create, and never reused because retiring a signal archives it instead of deleting it. An archived
// signal cannot be active. Rule changes are versioned and only reviewed rules run.
export const SIGNAL_KEY=/^[a-z][a-z0-9_]{1,62}$/;
const MAX_SOURCES=12;
/** "Security review needed!" -> "security_review_needed". Pure. */
export function signalKeyFrom(name){
  let k=String(name??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  if(!/^[a-z]/.test(k))k=`signal_${k}`.replace(/_+$/,'');
  k=k.slice(0,63).replace(/_+$/,'');
  return k.length<2?'signal':k;
}
/** The first of base, base_2, base_3… not in `taken` (every key the workspace ever used). Pure. */
export function uniqueSignalKey(base,taken){
  const used=new Set(taken);if(!used.has(base))return base;
  for(let n=2;;n++){const k=`${base.slice(0,63-String(n).length-1)}_${n}`;if(!used.has(k))return k;}
}
function cleanSources(sources){
  if(sources==null)return null;
  if(!Array.isArray(sources)||sources.length>MAX_SOURCES||sources.some(s=>typeof s!=='string'||!/^[a-z0-9_.-]{1,40}$/i.test(s)))fail(400,`Choose up to ${MAX_SOURCES} sources by name.`);
  return [...new Set(sources.map(s=>s.toLowerCase()))];
}
const listed=r=>({...r,archived:!!r.archived_at});
export async function listCustomSignals(sb,ws,uid){await revboxMembership(sb,ws,uid);return (await q(sb.from('custom_signal_definitions').select('*').eq('workspace_id',ws).order('name'))??[]).map(listed);}
/** How many account signals each definition has raised ({ [id]: count }, null when unknown). One head count each. */
export async function customSignalHits(sb,ws,ids){
  const out={};
  await Promise.all((ids??[]).map(async id=>{try{const {count,error}=await sb.from('account_signals').select('id',{count:'exact',head:true}).eq('workspace_id',ws).eq('kind',`custom_${id}`);out[id]=error?null:(count??0);}catch{out[id]=null;}}));
  return out;
}
export async function saveCustomSignal(sb,ws,uid,body,id=null){
  await revboxMembership(sb,ws,uid);
  body=body??{};
  if(typeof body.name!=='string'||!body.name.trim()||body.name.length>100||typeof body.rule!=='string'||!body.rule.trim()||body.rule.length>4000||(body.examples!=null&&(typeof body.examples!=='string'||body.examples.length>8000)))fail(400,'Choose a name, rules and examples within the limits.');
  const examples=body.examples??'';
  const ownerId=body.owner_id??uid;
  await revboxMembership(sb,ws,ownerId);
  const sources=cleanSources(body.sources);
  const old=id?await q(sb.from('custom_signal_definitions').select('*').eq('workspace_id',ws).eq('id',id).maybeSingle()):null;
  if(id&&!old)fail(404,'Signal not found.');
  if(old&&old.owner_id!==uid)fail(403,'Only the signal owner can change its rules.');
  if(old&&body.version!==old.version)fail(409,'This signal changed. Reload before saving.');
  if(old?.archived_at)fail(409,'This signal is archived. Create a new signal instead.');
  if(old&&body.key!=null&&body.key!==old.key)fail(400,'A signal key cannot change after it is created.');
  let key=old?.key;
  if(!old){
    // The box it was proposed in is optional; when given, the creator must be able to see it.
    if(body.revbox_id!=null)await loadRevbox(sb,ws,uid,body.revbox_id);
    if(body.key!=null&&(typeof body.key!=='string'||!SIGNAL_KEY.test(body.key)))fail(400,'A key is 2-63 lowercase letters, digits or underscores, starting with a letter.');
    const taken=(await q(sb.from('custom_signal_definitions').select('key').eq('workspace_id',ws))??[]).map(r=>r.key);
    if(body.key!=null&&taken.includes(body.key))fail(409,'This workspace already used that key. Choose another.');
    key=body.key??uniqueSignalKey(signalKeyFrom(body.name),taken);
  }
  if(body.active===true&&!old?.active){const active=await q(sb.from('custom_signal_definitions').select('id').eq('workspace_id',ws).eq('active',true).limit(30));if(active.length>=30)fail(400,'Pause an existing rule before activating another. A workspace can have 30 active signal rules.');}
  const now=new Date().toISOString();
  const patch={cursor_claim_id:null,versions:[...(old?.versions??[]),{version:(old?.version??0)+1,name:body.name,rule:body.rule,examples,owner_id:ownerId,active:body.active===true,reviewed_by:uid,reviewed_at:now}].slice(-50),name:body.name.trim(),rule:body.rule.trim(),examples,owner_id:ownerId,version:(old?.version??0)+1,active:body.active===true,cursor_at:now,updated_at:now,...(sources?{sources}:{})};
  if(old)return listed(await q(sb.from('custom_signal_definitions').update(patch).eq('workspace_id',ws).eq('id',id).eq('version',old.version).select('*').single()));
  const {data,error}=await sb.from('custom_signal_definitions').insert({...patch,workspace_id:ws,key,sources:sources??[],revbox_id:body.revbox_id??null}).select('*').single();
  if(error?.code==='23505')fail(409,'This workspace already used that key. Choose another.');
  if(error)throw error;
  return listed(data);
}
/** Retire a signal: it stops running and leaves the picker, its key is never reused. Owner only. */
export async function archiveCustomSignal(sb,ws,uid,id){
  await revboxMembership(sb,ws,uid);
  const old=await q(sb.from('custom_signal_definitions').select('*').eq('workspace_id',ws).eq('id',id).maybeSingle());
  if(!old)fail(404,'Signal not found.');
  if(old.owner_id!==uid)fail(403,'Only the signal owner can archive it.');
  if(old.archived_at)return listed(old);
  const now=new Date().toISOString();
  return listed(await q(sb.from('custom_signal_definitions').update({active:false,archived_at:now,updated_at:now,version:old.version+1,versions:[...(old.versions??[]),{version:old.version+1,owner_id:uid,reason:'archive',active:false,reviewed_at:now}].slice(-50)}).eq('workspace_id',ws).eq('id',id).eq('version',old.version).select('*').single()));
}
export async function activeCustomSignals(sb){const all=[];for(let start=0;;start+=500){const page=await q(sb.from('custom_signal_definitions').select('*').eq('active',true).is('archived_at',null).order('id').range(start,start+499));all.push(...(page??[]));if(!page||page.length<500)return all;}}
export async function customSignalCandidates(sb,definition){
  let search=sb.from('claims').select('id,entity_id,property,value,supporting_observation_ids,derived_visibility,computed_at').eq('workspace_id',definition.workspace_id).is('invalid_at',null).like('property','note.%').order('computed_at').order('id').limit(5);
  search=definition.cursor_claim_id?search.or(`computed_at.gt.${definition.cursor_at},and(computed_at.eq.${definition.cursor_at},id.gt.${definition.cursor_claim_id})`):search.gt('computed_at',definition.cursor_at);
  const candidates=await q(search);
  const readable=await filterDerivedForViewer(sb,definition.workspace_id,candidates??[],TEAM_VIEWER,{isDerived:()=>true});
  return {candidates:candidates??[],readable};
}
export async function claimCustomExtraction(sb,definition,claim){
  const {data,error}=await sb.from('custom_signal_extractions').insert({definition_id:definition.id,version:definition.version,claim_id:claim.id,claim_computed_at:claim.computed_at}).select('*').single();
  if(error?.code==='23505')return null;if(error)throw error;return data;
}
export async function finishCustomExtraction(sb,id,patch){return q(sb.from('custom_signal_extractions').update(patch).eq('id',id));}
export async function advanceCustomSignal(sb,definition,claim){return q(sb.from('custom_signal_definitions').update({cursor_at:claim.computed_at,cursor_claim_id:claim.id}).eq('id',definition.id).eq('version',definition.version));}
export async function customSignalAccount(sb,ws,entityId){const row=await q(sb.from('entity_list_rows').select('kind,company_id').eq('workspace_id',ws).eq('entity_id',entityId).maybeSingle());return row?.kind==='account'?entityId:row?.company_id??null;}
export async function customSignalIsCurrent(sb,definition){
  const current=await q(sb.from('custom_signal_definitions').select('id').eq('workspace_id',definition.workspace_id).eq('id',definition.id).eq('version',definition.version).eq('active',true).maybeSingle());
  return !!current;
}
export async function customSignalRulesForWorkspace(sb,ws){
  return q(sb.from('custom_signal_definitions').select('id,key,name,rule,examples,version,active,sources,archived_at').eq('workspace_id',ws).eq('active',true).is('archived_at',null).order('created_at'));
}
export async function reprocessCustomSignal(sb,ws,uid,id,since){
  await revboxMembership(sb,ws,uid);
  const definition=await q(sb.from('custom_signal_definitions').select('*').eq('workspace_id',ws).eq('id',id).maybeSingle());
  if(!definition||definition.owner_id!==uid)fail(404,'Signal not found.');
  const at=new Date(since);if(Number.isNaN(at.getTime())||at.getTime()>Date.now()||at.getTime()<Date.now()-90*86400000)fail(400,'Choose a start date within the last 90 days.');
  if(definition.archived_at)fail(409,'This signal is archived.');
  if(!definition.active)fail(400,'Activate the reviewed rule before reprocessing.');
  return q(sb.from('custom_signal_definitions').update({version:definition.version+1,cursor_at:at.toISOString(),cursor_claim_id:null,versions:[...(definition.versions??[]),{version:definition.version+1,rule:definition.rule,examples:definition.examples,owner_id:uid,reason:'reprocess',since:at.toISOString(),reviewed_at:new Date().toISOString()}].slice(-50)}).eq('workspace_id',ws).eq('id',id).eq('version',definition.version).select('*').single());
}
export async function publishCustomSignal(sb,definition,claim,accountId,extraction,result){
  return q(sb.from('account_signals').upsert({workspace_id:definition.workspace_id,entity_id:claim.entity_id,account_id:accountId,kind:`custom_${definition.id}`,claim_property:claim.property,title:definition.name,content:typeof claim.value?.content==='string'?claim.value.content:result.quote,quote:result.quote,source_ref:claim.value?.source_ref??claim.property,detail:{signal_id:definition.id,signal_version:definition.version,extraction_id:extraction.id},team_readable:true,occurred_at:claim.computed_at,dedupe_key:`custom:${definition.id}:${definition.version}:${claim.id}:${claim.computed_at}`},{onConflict:'workspace_id,dedupe_key',ignoreDuplicates:true}));
}
/**
 * The signal catalog for one workspace (service use, no membership check: the caller has done it):
 * built-ins plus every non-archived custom signal, drafts included (entry.active tells them apart).
 * `activeOnly` keeps just the live ones, for an agent that should only pick what runs.
 */
export async function loadSignalCatalog(sb,ws,{activeOnly=false}={}){
  let query=sb.from('custom_signal_definitions').select('id,key,name,rule,version,active,sources,archived_at').eq('workspace_id',ws).is('archived_at',null);
  if(activeOnly)query=query.eq('active',true);
  return signalCatalog({custom:await q(query.order('name'))});
}
