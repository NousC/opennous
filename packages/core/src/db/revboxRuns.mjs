import { revboxExecutionRequirements } from '../services/revboxPlan.mjs';
import { filterDerivedForViewer, TEAM_VIEWER } from '../privacy/messagePrivacy.mjs';
import { loadRevbox, revboxConnections } from './revboxes.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
async function query(q){const {data,error}=await q;if(error)throw error;return data;}
export async function loadRevboxJob(sb,ws,uid,boxId,jobId,edit=false){
  const box=await loadRevbox(sb,ws,uid,boxId,edit);
  const job=await query(sb.from('revbox_jobs').select('*').eq('workspace_id',ws).eq('revbox_id',boxId).eq('id',jobId).maybeSingle());
  if(!job)fail(404,'Job not found.');return {box,job};
}
export async function enableRevboxJob(sb,ws,uid,boxId,jobId,enabled,nextRunAt=null){
  const {box,job}=await loadRevboxJob(sb,ws,uid,boxId,jobId,true);
  if(enabled){const error=revboxExecutionRequirements(job,box);if(error)fail(400,error);}
  if(enabled && job.state!=='reviewed')fail(400,'Approve the plan first.');
  if(enabled && job.plan.tools.includes('gmail')&&!job.plan.email?.to&&job.plan.email?.recipient_rule!=='meeting_attendees')fail(400,'Choose the Gmail draft recipient first.');
  if(enabled && job.plan.questions?.length)fail(400,'Resolve the open questions before enabling this job.');
  const connections=await revboxConnections(sb,ws,uid);
  if(enabled && Object.entries(job.plan.bindings??{}).some(([slug,id])=>!connections.some(c=>c.id===id&&c.slug===slug)))fail(400,'Reconnect the selected tools.');
  return query(sb.from('revbox_jobs').update({enabled,next_run_at:enabled?nextRunAt:null}).eq('workspace_id',ws).eq('id',jobId).eq('version',job.version).select('*').single());
}
export async function queueRevboxRun(sb,ws,uid,boxId,jobId,occurrence,snapshot,accountIds){
  const {box,job}=await loadRevboxJob(sb,ws,uid,boxId,jobId,true);
  if(snapshot.job.version!==job.version)fail(409,'The job changed before this run was queued.');
  if(job.plan.email?.recipient_rule==='meeting_attendees'&&!snapshot.event?.attendees?.some(a=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)))fail(400,'This job needs a meeting event with customer attendees.');
  const requirements=revboxExecutionRequirements(job,box);if(requirements)fail(400,requirements);
  if(job.state!=='reviewed')fail(400,'Approve the job first.');
  if(job.plan.tools.includes('gmail')&&!job.plan.email?.to&&job.plan.email?.recipient_rule!=='meeting_attendees')fail(400,'Choose the Gmail draft recipient first.');
  if(job.plan.questions?.length)fail(400,'Resolve the open questions before running this job.');
  const {data,error}=await sb.from('revbox_runs').insert({workspace_id:ws,revbox_id:boxId,job_id:jobId,actor_id:uid,job_version:job.version,occurrence,snapshot,account_ids:accountIds}).select('*').single();
  if(error?.code==='23505')return null;if(error)throw error;return data;
}
export async function listRevboxRuns(sb,ws,uid,boxId,allowed=null){
  await loadRevbox(sb,ws,uid,boxId);
  const runs=await query(sb.from('revbox_runs').select('*').eq('workspace_id',ws).eq('revbox_id',boxId).order('created_at',{ascending:false}).limit(100));
  // A report combining several accounts requires access to each source account.
  const candidates=(runs??[]).filter(run=>!allowed||run.account_ids.every(id=>allowed.has(id)));
  const ids=[...new Set(candidates.flatMap(run=>[...(run.snapshot?.evidence?.notes??[]).map(n=>n.id),...(run.snapshot?.event?.claim_id?[run.snapshot.event.claim_id]:[])]))];
  const readable=new Set();for(let offset=0;offset<ids.length;offset+=200){const facts=await query(sb.from('claims').select('id,entity_id,property,value,supporting_observation_ids,derived_visibility').eq('workspace_id',ws).in('id',ids.slice(offset,offset+200)).is('invalid_at',null));for(const f of await filterDerivedForViewer(sb,ws,facts??[],TEAM_VIEWER,{isDerived:()=>true}))readable.add(f.id);}
  const visible=[];for(const run of candidates){if(await revboxRunSourceReadable(sb,run,uid,readable))visible.push(run);}return visible;
}
export async function claimRevboxRun(sb,id){return query(sb.from('revbox_runs').update({state:'running',updated_at:new Date().toISOString()}).eq('id',id).eq('state','queued').select('*').maybeSingle());}
export async function finishRevboxRun(sb,id,patch){return query(sb.from('revbox_runs').update({...patch,updated_at:new Date().toISOString()}).eq('id',id).select('*').single());}
export async function pendingRevboxRuns(sb){return query(sb.from('revbox_runs').select('id').eq('state','queued').order('created_at').limit(10));}
export async function createRevboxDeliveries(sb,run,destinations){
  if(!destinations.length)return;
  return query(sb.from('revbox_deliveries').upsert(destinations.map(d=>({run_id:run.id,destination_id:d.id,destination:d})),{onConflict:'run_id,destination_id',ignoreDuplicates:true}));
}
export async function revboxDeliveries(sb,runId){return query(sb.from('revbox_deliveries').select('*').eq('run_id',runId));}
export async function claimRevboxDelivery(sb,id){return query(sb.from('revbox_deliveries').update({state:'sending',updated_at:new Date().toISOString()}).eq('id',id).in('state',['pending','failed']).select('*').maybeSingle());}
export async function finishRevboxDelivery(sb,id,patch){return query(sb.from('revbox_deliveries').update({...patch,updated_at:new Date().toISOString()}).eq('id',id));}
export async function dueRevboxJobs(sb,at){return query(sb.from('revbox_jobs').select('*').eq('enabled',true).lte('next_run_at',at).order('next_run_at').limit(20));}
export async function advanceRevboxSchedule(sb,job,next){return query(sb.from('revbox_jobs').update({next_run_at:next}).eq('id',job.id).eq('enabled',true).eq('version',job.version).eq('next_run_at',job.next_run_at).select('id').maybeSingle());}
export async function revboxWorkspaceRole(sb,ws,uid){return query(sb.from('workspace_members').select('role').eq('workspace_id',ws).eq('user_id',uid).maybeSingle());}
const eventTriggers={'conversation.call_ended':'call_ended','deal.won':'deal_closed_won','deal.lost':'deal_closed_lost','deal.stage_changed':'deal_stage_changed','account.signal':'account_signal','campaign.completed':'campaign_completed'};
export async function enqueueRevboxEvent(sb,{workspaceId,type,accountId=/** @type {string|null} */ (null),occurredAt=/** @type {string|null} */ (null),data={},dedupeKey}){
  const kind=type.startsWith('signal.')?'account_signal':eventTriggers[type];
  if(!kind)return;
  const jobs=await query(sb.from('revbox_jobs').select('id').eq('workspace_id',workspaceId).eq('enabled',true).contains('plan',{trigger:{kind}}).limit(1));
  if(!jobs?.length)return;
  return query(sb.from('revbox_events').upsert({workspace_id:workspaceId,type,account_id:accountId,occurred_at:occurredAt??new Date().toISOString(),data,owner_user_id:data.owner_user_id??null,dedupe_key:String(dedupeKey)},{onConflict:'workspace_id,type,dedupe_key',ignoreDuplicates:true}));
}
export async function pendingRevboxEvents(sb){return query(sb.from('revbox_events').select('*').is('processed_at',null).order('occurred_at').limit(20));}
export async function jobsForRevboxEvent(sb,event){
  const jobs=await query(sb.from('revbox_jobs').select('*').eq('workspace_id',event.workspace_id).eq('enabled',true).contains('plan',{trigger:{kind:event.type.startsWith('signal.')?'account_signal':eventTriggers[event.type]}}));
  return (jobs??[]).filter(j=>Date.parse(j.reviewed_at)<=Date.parse(event.occurred_at)&&(!event.owner_user_id||j.reviewed_by===event.owner_user_id)&&(!j.plan.trigger.signal_id||j.plan.trigger.signal_id===event.data.signal_id)&&(!j.plan.trigger.provider||!event.data.source||j.plan.trigger.provider===event.data.source));
}
export async function finishRevboxEvent(sb,id,error=null){return query(sb.from('revbox_events').update({processed_at:new Date().toISOString(),error}).eq('id',id));}
export async function revboxEventWorkspaces(sb,types){
  const kinds=types.map(type=>eventTriggers[type]).filter(Boolean);
  if(!kinds.length)return [];
  const jobs=await query(sb.from('revbox_jobs').select('workspace_id,plan').eq('enabled',true));
  return [...new Set((jobs??[]).filter(j=>kinds.includes(j.plan.trigger.kind)).map(j=>j.workspace_id))];
}

export async function approveRevboxRun(sb,ws,uid,boxId,runId,allowed=null){
  await loadRevbox(sb,ws,uid,boxId,true);
  const run=await query(sb.from('revbox_runs').select('*').eq('workspace_id',ws).eq('revbox_id',boxId).eq('id',runId).maybeSingle());
  if(!run||allowed&&run.account_ids.some(id=>!allowed.has(id))||!await revboxRunSourceReadable(sb,run,uid))fail(404,'Result not found.');
  if(run.state!=='needs_review')fail(409,'This result has already been reviewed.');
  return query(sb.from('revbox_runs').update({state:'completed',updated_at:new Date().toISOString()}).eq('workspace_id',ws).eq('id',runId).eq('state','needs_review').select('*').maybeSingle());
}
export async function setRevboxWebhookKey(sb,ws,uid,boxId,jobId,hash){await loadRevboxJob(sb,ws,uid,boxId,jobId,true);return query(sb.from('revbox_webhook_keys').upsert({job_id:jobId,key_hash:hash}));}
export async function jobForRevboxWebhook(sb,hash){const key=await query(sb.from('revbox_webhook_keys').select('job_id').eq('key_hash',hash).maybeSingle());if(!key)return null;return query(sb.from('revbox_jobs').select('*').eq('id',key.job_id).eq('enabled',true).maybeSingle());}

export async function revboxRunSourceReadable(sb,run,uid,readable=null){
  const noteIds=(run.snapshot?.evidence?.notes??[]).map(n=>n.id);
  if(readable&&noteIds.some(id=>!readable.has(id)))return false;
  for(let start=0;!readable&&start<noteIds.length;start+=100){
    const ids=noteIds.slice(start,start+100);
    const facts=await query(sb.from('claims').select('id,entity_id,property,value,supporting_observation_ids,derived_visibility').eq('workspace_id',run.workspace_id).in('id',ids).is('invalid_at',null));
    if((await filterDerivedForViewer(sb,run.workspace_id,facts??[],TEAM_VIEWER,{isDerived:()=>true})).length!==ids.length)return false;
  }
  const event=run.snapshot?.event;
  if(event?.owner_user_id&&event.owner_user_id!==uid)return false;
  if(!event?.claim_id&&!event?.claim_property)return true;
  if(readable&&event.claim_id)return readable.has(event.claim_id);
  let source=sb.from('claims').select('entity_id,property,value,supporting_observation_ids,derived_visibility').eq('workspace_id',run.workspace_id).is('invalid_at',null);
  source=event.claim_id?source.eq('id',event.claim_id):source.eq('entity_id',event.entity_id).eq('property',event.claim_property);
  const claim=await query(source.maybeSingle());
  if(!claim)return false;
  return (await filterDerivedForViewer(sb,run.workspace_id,[claim],TEAM_VIEWER,{isDerived:()=>true})).length===1;
}
export async function loadRevboxRunForEdit(sb,ws,uid,boxId,runId,allowed=null){
  await loadRevbox(sb,ws,uid,boxId,true);
  const run=await query(sb.from('revbox_runs').select('*').eq('workspace_id',ws).eq('revbox_id',boxId).eq('id',runId).maybeSingle());
  if(!run||allowed&&run.account_ids.some(id=>!allowed.has(id))||!await revboxRunSourceReadable(sb,run,uid))fail(404,'Result not found.');return run;
}
export async function recoverInterruptedRevboxWork(sb,before){
  await query(sb.from('revbox_deliveries').update({state:'uncertain',error:'Delivery was interrupted. Check the destination before taking further action.'}).eq('state','sending').lt('updated_at',before));
  await query(sb.from('revbox_runs').update({state:'failed',error:'Execution was interrupted. Review its usage before starting a new run.'}).eq('state','running').lt('updated_at',before));
}
export async function revboxAccountEvidence(sb,ws,accountIds){
  const entities=[...accountIds];const deals=[];const notes=[];
  for(let start=0;start<accountIds.length;start+=100){
    const linked=await query(sb.from('entity_list_rows').select('entity_id,kind,name,company_id,stage').eq('workspace_id',ws).in('company_id',accountIds.slice(start,start+100)).in('kind',['person','deal']).limit(1000));
    entities.push(...(linked??[]).map(e=>e.entity_id));deals.push(...(linked??[]).filter(e=>e.kind==='deal'));
  }
  for(let start=0;start<entities.length;start+=100){
    const facts=await query(sb.from('claims').select('id,entity_id,property,value,supporting_observation_ids,derived_visibility').eq('workspace_id',ws).in('entity_id',entities.slice(start,start+100)).like('property','note.%').is('invalid_at',null).order('computed_at',{ascending:false}).limit(100));
    notes.push(...await filterDerivedForViewer(sb,ws,facts??[],TEAM_VIEWER,{isDerived:()=>true}));
  }
  return {deals,notes:notes.map(n=>({id:n.id,entity_id:n.entity_id,property:n.property,value:n.value}))};
}
