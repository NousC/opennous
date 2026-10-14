import { revboxAccountEvidence, loadRevboxJob, revboxDetails, revboxAccountCatalog, revboxMatchesAccount, getDocument, revboxWorkspaceRole } from '@nous/core';

/**
 * The document row a RevBox may use, or null. getDocument returns { document, subject, … }: reading
 * `title` or `subject_entity_id` off that wrapper passed every privacy check and gave empty bodies
 * (GET-868). `allowed` null = the viewer is not restricted to a set of accounts.
 */
export function visibleDocument(detail, allowed) {
  const doc = detail?.document ?? null;
  if (!doc) return null;
  if (doc.subject_entity_id && allowed && !allowed.has(doc.subject_entity_id)) return null;
  return doc;
}
import { viewerVisibleAccountSet } from './visibility.mjs';

export async function makeRevboxSnapshot(sb,ws,uid,boxId,jobId,event=null){
  const {box,job}=await loadRevboxJob(sb,ws,uid,boxId,jobId,true);
  const member=await revboxWorkspaceRole(sb,ws,uid);
  const visible=await viewerVisibleAccountSet(sb,ws,uid,{isAdmin:['admin','owner'].includes(member?.role)});
  const allowed=visible.unrestricted?null:visible.ids;
  if(event?.campaign_id && (allowed||box.scope.mode!=='all'))throw Object.assign(new Error('Campaign analysis requires workspace-wide account access and the All accounts filter.'),{status:403});
  let accounts=(await revboxAccountCatalog(sb,ws,allowed)).filter(a=>revboxMatchesAccount(box.scope,a));
  if(event?.account_id)accounts=accounts.filter(a=>a.id===event.account_id);
  if(!accounts.length)throw Object.assign(new Error('No accessible accounts match this job.'),{status:400});
  const detail=await revboxDetails(sb,ws,uid,boxId);
  const context=[];const sourceIds=new Set(accounts.map(a=>a.id));
  for(const c of detail.context){
    if(!c.document_id)context.push({title:c.title,body:c.body});
    else{
      const doc=visibleDocument(await getDocument(sb,ws,c.document_id),allowed);
      if(!doc)throw Object.assign(new Error('A context reference is no longer accessible.'),{status:403});
      context.push({title:doc.title,body:doc.body_md??''});if(doc.subject_entity_id)sourceIds.add(doc.subject_entity_id);
    }
  }
  const evidence=await revboxAccountEvidence(sb,ws,accounts.map(a=>a.id));
  const snapshot={evidence,box:{objective:box.objective,blocks:box.blocks,delivery:box.delivery,scope:box.scope},job:{version:job.version,prompt:job.prompt,plan:job.plan},context,accounts,event};
  if(JSON.stringify(snapshot).length>200000)throw Object.assign(new Error('This job has too much context. Narrow the account filter or reference files.'),{status:400});
  return {job,snapshot,accountIds:[...sourceIds]};
}
