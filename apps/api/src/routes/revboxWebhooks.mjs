import {Router} from 'express';
import {createHash} from 'node:crypto';
import {getSupabaseClient,jobForRevboxWebhook,queueRevboxRun} from '@nous/core';
import {makeRevboxSnapshot} from '../lib/revboxSnapshot.mjs';
import {revboxCreditGate} from '../lib/revboxRuntime.mjs';
export const revboxWebhooksRouter=Router();
revboxWebhooksRouter.post('/',async(req,res)=>{
  try{
    const key=req.get('x-revbox-key');if(typeof key!=='string'||key.length<32)return res.status(401).json({error:'Invalid webhook key.'});
    const eventId=req.get('idempotency-key');if(typeof eventId!=='string'||!eventId.trim()||eventId.length>200)return res.status(400).json({error:'Provide an Idempotency-Key for this event.'});
    const sb=getSupabaseClient();const job=await jobForRevboxWebhook(sb,createHash('sha256').update(key).digest('hex'));
    if(!job||job.plan.trigger.kind!=='webhook_in')return res.status(404).json({error:'Webhook job not found.'});
    if(JSON.stringify(req.body??{}).length>20000)return res.status(413).json({error:'Webhook payload is too large.'});
    await revboxCreditGate(sb,job.workspace_id);
    const {snapshot,accountIds}=await makeRevboxSnapshot(sb,job.workspace_id,job.reviewed_by,job.revbox_id,job.id,req.body??{});
    const run=await queueRevboxRun(sb,job.workspace_id,job.reviewed_by,job.revbox_id,job.id,`webhook:${eventId}`,snapshot,accountIds);
    res.status(202).json({accepted:true,run_id:run?.id??null,duplicate:!run});
  }catch(error){console.error('[revbox-webhook]',error.message);res.status(error.status??500).json({error:error.status?error.message:'Could not accept this event.'});}
});
