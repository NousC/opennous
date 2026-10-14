import { resolveTeamAndPlan } from './access.mjs';
import { hasFeature, isSelfHosted } from './plans.mjs';
import { makeRevboxSnapshot } from './revboxSnapshot.mjs';
import { randomUUID } from 'node:crypto';
import { publishCustomSignal, customSignalIsCurrent, recoverInterruptedRevboxWork, revboxRunSourceReadable, activeCustomSignals, customSignalCandidates, claimCustomExtraction, finishCustomExtraction, advanceCustomSignal, customSignalAccount, classifyCustomSignal, enqueueRevboxEvent, pendingRevboxEvents, jobsForRevboxEvent, finishRevboxEvent, dueRevboxJobs, advanceRevboxSchedule, revboxNextRunAt, queueRevboxRun, revboxWorkspaceRole, createMessage, executeRevboxRun, recordRevboxUsage, claimRevboxRun, finishRevboxRun, pendingRevboxRuns, loadRevboxJob, loadRevbox, revboxMembership, createRevboxDeliveries, revboxDeliveries, claimRevboxDelivery, finishRevboxDelivery } from '@nous/core';
import { requireAiCredits } from './plans.mjs';
import { computeCost } from './llmUsage.mjs';
import { viewerVisibleAccountSet } from './visibility.mjs';
import { postAutomationSlack, automationGmailDraft } from './automationSteps.mjs';
import { safeFetch } from './ssrf.mjs';

export async function revboxCreditGate(sb,ws){if(!isSelfHosted()){const {plan}=await resolveTeamAndPlan({workspaceId:ws});if(!hasFeature(plan.id,'revboxes'))throw Object.assign(new Error('RevBoxes are not available on this workspace plan.'),{status:402});}const gate=await requireAiCredits(sb,ws);if(!gate.ok)throw Object.assign(new Error(gate.body.message??'Credits are required.'),{status:gate.status});}
export async function meterRevboxResponse(sb,run,response,feature='revbox-run'){
  await recordRevboxUsage(sb,{workspaceId:run.workspace_id,userId:run.actor_id,boxId:run.revbox_id,jobId:run.job_id,runId:run.id,feature,model:response.model,usage:response.usage,costUsd:computeCost(response.model,response.usage),requestId:`${feature}:${randomUUID()}`});
}
export async function assertRunAccess(sb,run){
  await revboxMembership(sb,run.workspace_id,run.actor_id);
  if(!await revboxRunSourceReadable(sb,run,run.actor_id))throw new Error('The source evidence is no longer accessible.');
  await loadRevbox(sb,run.workspace_id,run.actor_id,run.revbox_id,true);
  const member=await revboxWorkspaceRole(sb,run.workspace_id,run.actor_id);
  const visible=await viewerVisibleAccountSet(sb,run.workspace_id,run.actor_id,{isAdmin:['admin','owner'].includes(member?.role)});
  if(!visible.unrestricted&&run.account_ids.some(id=>!visible.ids.has(id)))throw new Error('A source account is no longer accessible.');
}
export async function deliverRevboxRun(sb,run,onlyGmail=false){
  await assertRunAccess(sb,run);
  for(const delivery of await revboxDeliveries(sb,run.id)){
    if(onlyGmail&&delivery.destination.kind!=='gmail')continue;
    const claimed=await claimRevboxDelivery(sb,delivery.id);if(!claimed)continue;
    const d=claimed.destination;
    try{
      if(d.kind==='gmail'){
        const response=await automationGmailDraft({supabase:sb,workspaceId:run.workspace_id,userId:run.actor_id,to:d.target,subject:run.result.subject??run.result.title,body:run.result.body,connectionId:d.connection_id});
        if(response.status!=='created')throw new Error(response.error??response.status??'Gmail draft failed.');
      }else if(d.kind==='slack'){
        const response=await postAutomationSlack({supabase:sb,workspaceId:run.workspace_id,channel:d.target,text:`${run.result.title}\n\n${run.result.body}`});
        if(!response.ok)throw Object.assign(new Error(response.reason??'Slack delivery failed.'),{retrySafe:true});
      }else{
        const response=await safeFetch(d.target,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':delivery.id},body:JSON.stringify({id:delivery.id,revbox_id:run.revbox_id,job_id:run.job_id,run_id:run.id,result:run.result})},{maxRedirects:0});
        if(!response.ok)throw Object.assign(new Error(`Webhook returned ${response.status}.`),{retrySafe:response.status>=400&&response.status<500&&response.status!==408});
      }
      await finishRevboxDelivery(sb,delivery.id,{state:'sent',error:null});
    }catch(error){
      // A timeout can follow a successful external write. Do not retry it automatically.
      await finishRevboxDelivery(sb,delivery.id,{state:error.retrySafe?'failed':'uncertain',error:error.message});
    }
  }
}
export async function processRevboxRun(sb,id,adapters={}){
  const checkAccess=adapters.checkAccess??assertRunAccess;
  const loadJob=adapters.loadJob??loadRevboxJob;
  const gate=adapters.gate??(()=>revboxCreditGate(sb,run.workspace_id));
  const generate=adapters.generate??createMessage;
  const meter=adapters.meter??(response=>meterRevboxResponse(sb,run,response));
  const deliver=adapters.deliver??deliverRevboxRun;
  const run=await claimRevboxRun(sb,id);if(!run)return;
  try{
    await checkAccess(sb,run);
    const {job}=await loadJob(sb,run.workspace_id,run.actor_id,run.revbox_id,run.job_id,true);
    if(run.occurrence && !run.occurrence.startsWith('manual:')&&!job.enabled)throw new Error('This job was paused before the run started.');
    if(job.version!==run.job_version||job.state!=='reviewed')throw new Error('This job changed after the run was queued.');
    const result=await executeRevboxRun(run,{gate,generate,meter});
    const needsReview=run.snapshot.job.plan.steps.some(s=>s.type==='approval')||result.kind==='draft';
    const finished=await finishRevboxRun(sb,id,{result,state:needsReview?'needs_review':'completed'});
    // Legacy jobs deliver to Slack and webhooks only; a box's email/Gmail destinations (GET-868) are the engine routines'.
    const destinations=run.snapshot.box.delivery.filter(d=>d.target&&['slack','webhook'].includes(d.kind));
    if(run.snapshot.job.plan.tools.includes('gmail'))destinations.push({id:'gmail-draft',kind:'gmail',target:run.snapshot.job.plan.email.recipient_rule==='meeting_attendees'?[...new Set((run.snapshot.event?.attendees??[]).map(a=>a.email).filter(email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))].join(','):run.snapshot.job.plan.email.to,connection_id:run.snapshot.job.plan.bindings.gmail});
    await createRevboxDeliveries(sb,finished,destinations);
    if(needsReview)await deliver(sb,finished,true);
    if(!needsReview)await deliver(sb,finished);
  }catch(error){await finishRevboxRun(sb,id,{state:'failed',error:error.message});}
}
export function startRevboxRuntime(sb){
  let busy=false;
  const tick=async()=>{if(busy)return;busy=true;try{await recoverInterruptedRevboxWork(sb,new Date(Date.now()-10*60*1000).toISOString());await scheduleRevboxJobs(sb);await dispatchRevboxEvents(sb);for(const run of await pendingRevboxRuns(sb))await processRevboxRun(sb,run.id);}catch(error){console.error('[revbox-runtime]',error.message);}finally{busy=false;}};
  let extracting=false;const extractionTick=async()=>{if(extracting)return;extracting=true;try{await extractCustomSignals(sb);}catch(error){console.error('[custom-signals]',error.message);}finally{extracting=false;}};
  const timer=setInterval(tick,15000);const signalTimer=setInterval(extractionTick,60000);timer.unref();signalTimer.unref();return()=>{clearInterval(timer);clearInterval(signalTimer);};
}

export async function scheduleRevboxJobs(sb,at=new Date()){
  for(const job of await dueRevboxJobs(sb,at.toISOString())){
    try{
      const {snapshot,accountIds}=await makeRevboxSnapshot(sb,job.workspace_id,job.reviewed_by,job.revbox_id,job.id);
      await queueRevboxRun(sb,job.workspace_id,job.reviewed_by,job.revbox_id,job.id,`clock:${job.next_run_at}`,snapshot,accountIds);
      const t=job.plan.trigger;
      await advanceRevboxSchedule(sb,job,revboxNextRunAt(t,at)?.toISOString()??null);
    }catch(error){console.error('[revbox-schedule]',job.id,error.message);}
  }
}

export async function dispatchRevboxEvents(sb){
  for(const event of await pendingRevboxEvents(sb)){
    let error=null;
    for(const job of await jobsForRevboxEvent(sb,event)){
      try{
        if(event.type==='conversation.call_ended'&&!event.owner_user_id)continue;
        const {snapshot,accountIds}=await makeRevboxSnapshot(sb,job.workspace_id,job.reviewed_by,job.revbox_id,job.id,{...event.data,account_id:event.account_id});
        await queueRevboxRun(sb,job.workspace_id,job.reviewed_by,job.revbox_id,job.id,`event:${event.id}`,snapshot,accountIds);
      }catch(e){error=e.message;}
    }
    await finishRevboxEvent(sb,event.id,error);
  }
}

export async function extractCustomSignals(sb){
  let remaining=10;
  for(const definition of await activeCustomSignals(sb)){
    try{
      await revboxMembership(sb,definition.workspace_id,definition.owner_id);
      const {candidates,readable}=await customSignalCandidates(sb,definition);
      for(const claim of readable){
        if(remaining<=0)return;remaining--;
        const accountId=await customSignalAccount(sb,definition.workspace_id,claim.entity_id);if(!accountId)continue;
        await revboxCreditGate(sb,definition.workspace_id);
        const extraction=await claimCustomExtraction(sb,definition,claim);if(!extraction)continue;
        try{
          const result=await classifyCustomSignal(definition,claim,{gate:()=>revboxCreditGate(sb,definition.workspace_id),generate:createMessage,meter:response=>recordRevboxUsage(sb,{workspaceId:definition.workspace_id,userId:definition.owner_id,boxId:definition.revbox_id,feature:'revbox-custom-signal',model:response.model,usage:response.usage,costUsd:computeCost(response.model,response.usage),requestId:`custom-signal:${extraction.id}`})});
          await revboxMembership(sb,definition.workspace_id,definition.owner_id);
          if(result&&await customSignalIsCurrent(sb,definition))await publishCustomSignal(sb,definition,claim,accountId,extraction,result);
          await finishCustomExtraction(sb,extraction.id,{state:result?'matched':'unmatched',quote:result?.quote??null});
        }catch(error){await finishCustomExtraction(sb,extraction.id,{state:'failed',error:error.message});}
      }
      if(candidates.length)await advanceCustomSignal(sb,definition,candidates.at(-1));
    }catch(error){console.error('[custom-signals]',definition.id,error.message);}
  }
}
