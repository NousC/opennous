export * from './types.js';
export * from './replySignals.js';
export * from './intentBand.js';
export * from './dateResolve.js';
export * from './db/client.js';
export * from './db/entities.js';
export * from './db/entityOverlay.js';
export * from './db/pipelineStage.js';
export * from './db/observations.js';
export * from './db/workspaceStages.js';
export * from './db/workspacePipelines.js';
export * from './db/supportAccess.js';
export * from './db/crmWriteState.js';
export * from './db/crmPipelineRef.js';
export * from './db/companyFamily.js';
export * from './db/claims.js';
export * from './db/teamMembers.js';
export * from './db/workspaceDomains.js';
export * from './db/relationship.js';
export * from './db/graph.js';
export * from './db/relationshipOwner.js';
export * from './db/readContext.js';
export * from './db/predictions.js';
export * from './db/externalScores.js';
export * from './db/notes.js';
export * from './db/intelTimeline.js';
export * from './db/conversationCredits.js';
export * from './db/intelTopics.js';
export * from './db/documents.js';
export * from './db/brains.js';
export * from './db/meetingSummaries.js';
export * from './db/meetingTasks.js';
export * from './db/meetingTaskClosure.js';
export * from './db/insightSynthesis.js';
export * from './db/playbookProposals.js';
export * from './db/claimCategories.js';
export * from './db/claimTime.js';
export * from './db/insightCategories.js';
export * from './db/insights.js';
export * from './db/insightBoard.js';
export * from './db/flags.js';
export * from './db/features.js';
export * from './db/canonicalAxes.js';
export * from './db/conflicts.js';
export * from './db/identityProposals.js';
export * from './db/search.js';
export * from './context.js';
export * from './query.js';
export * from './attention.js';
export * from './pipeline.js';
export * from './embed.js';
export * from './evidence.js';
export * from './counterEvidence.js';
export * from './provenance.js';
export * from './evidenceDetail.js';
export * from './explainIdentity.js';
export * from './db/contacts.js';
export * from './db/leads.js';
export * from './db/campaignMessages.js';
export * from './db/campaignStats.js';
export * from './db/scorecard.js';
export * from './db/workerRuns.js';
export * from './db/companies.js';
export * from './db/activities.js';
export * from './db/observationDeals.js';
export * from './db/pipelineStageStats.js';
export * from './db/pipelineWeek.js';
export * from './services/crmAgent.js';
export * from './services/followUps.js';
export * from './db/linearIssueLinks.js';
export * from './services/linearIssues.js';
export * from './db/triggers.js';
export * from './db/webhookDeliveries.js';
export * from './db/managedWebhooks.js';
export * from './db/githubDispatch.js';
export * from './db/coachingRubric.js';
export * from './db/callScorecards.js';
export * from './services/callScoring.js';
export * from './services/callPage.js';
export * from './services/settleClaimQueue.js';
export * from './services/accountHealth.js';
export * from './services/accountHealthState.js';
export * from './services/expansionProduct.js';
export * from './services/dealCloseRecord.js';
export * from './services/backfillLock.js';
export * from './services/callReviewStore.js';
export * from './db/workspaces.js';
// Note: db/memories.ts removed in Phase 1 — superseded by db/notes.ts (claim-shaped).
export * from './utils/identity.js';
export * from './utils/email.js';
export * from './utils/linkedin.js';
export * from './utils/encryption.js';
export * from './utils/googleAuth.js';
export * from './services/crmPush.js';
export * from './services/crmWriteback.js';
export * from './services/hubspotAutomation.js';
export { AI_FIELD_DEFAULTS, buildFieldsPrompt, parseFieldsAnswer } from './services/crmFieldsFromConversation.mjs';
export { EMAIL_DRAFT_SYSTEM, DEFAULT_SUBJECT, parseEmailDraft } from './services/emailDraftBrief.mjs';
export * from './services/outcomes.js';
export * from './services/icpScorer.js';
export * from './services/pipelineFeatures.js';
export * from './services/funnelTimeline.js';
export * from './services/dealRollup.js';
export * from './services/forecast.js';
export * from './services/forecastRun.js';
export * from './services/winModel.js';
export * from './services/crmHygiene.js';
export * from './services/crmProvenance.js';
export * from './services/crmReconcile.js';
export * from './services/crmApply.js';
export * from './services/actionItems.js';
export { TASK_STATUSES, parseTaskId, taskIdOf, statusValue, planBulk, readTaskClaims, applyBulkStatus } from './services/taskStatus.mjs';
export * from './services/campaignSync.js';
export * from './services/mentions.js';
export * from './services/committee.js';
export * from './services/meetingPolicy.js';
export * from './services/promiseRecurrence.js';
export * from './services/titleRead.js';
export * from './services/adoptCrmOwnership.js';
export * from './services/canonicalProjection.js';
export * from './integrations/crm/index.js';
export * from './integrations/crm/portal.js';
export * from './integrations/ringcentral.js';
// The data audit, shared by the API route (`nous audit`) and the nightly worker sweep.
export { runAudit } from './audit.mjs';
// Who owes whom a reply, from the order of touches (GET-255).
export { replyOwedFromTouches, loadReplyOwed, touchDirection, REPLY_TOUCH_PROPERTIES } from './services/replyOwed.mjs';
// HTML → text for message bodies and previews (GET-249). One stripper instead of four.
export { htmlToText, messageBodyText, splitMessage, dropQuotedText, decodeEntities, looksLikeHtml } from './text/htmlToText.mjs';
// One pronoun guard for both writers — the worker's persistFacts and the API's record (GET-368).
export { violatesPronounRule, PRONOUN_RULE_REASON } from './text/pronounGuard.js';
export { isTitleOnlyFact, TITLE_ONLY_REASON } from './text/titleOnlyGuard.js';
export { isAutoNotification, AUTO_NOTIFICATION_REASON } from './text/autoNotification.js';
export { notACommitment } from './text/notACommitment.js';
// Message privacy by participant (GET-244): who may read an email's or LinkedIn message's content.
export {
  PRIVATE_MESSAGE_TYPES, isPrivateMessageType, messageParticipants, canReadMessage, messageDirection,
  redactedMessageLabel, redactObservationForViewer, redactActivityForViewer,
  applyMessagePrivacyToObservations, applyMessagePrivacyToActivities, loadMessageViewer, messageViewerForContext,
  redactObservationRowsForViewer, canReadMeetingRaw,
  // What was derived from a message follows the message (GET-253).
  TEAM_VIEWER, derivedSources, loadDerivedSources, canReadDerived, isDerivedProperty,
  filterDerivedForViewer, derivedViewerForContext, filterByCitedClaimsForViewer, derivedAudienceKey,
} from './privacy/messagePrivacy.mjs';
// The one model door (GET-242): every single-turn model call in the API and the worker goes
// through createMessage. Plain JS, carried into dist by allowJs.
// The automation engine. Both apps run it — the worker on a cron, the API for a test run —
// so it lives here rather than in either of them (GET-426).
export {
  runAutomationDailyPoll, runAutomationsForWorkspace, makeArtifactForTest, resendAutomationDocument,
  emitDealEventsPoll, emitIcpEventsPoll, emitPeopleAddedPoll, icpChanges, previewAutomationVars, composeAutomationEmail, automationEmailPreview, automationContextPreview, searchAutomationAccounts, CONTEXT_PARTS,
  processAccountSignals, listAccountSignals, SIGNAL_LABEL, SIGNAL_KINDS, runCallEndedAutomations, CALL_TRANSCRIPT_CHARS, registerStepHandler, rulesPass, rulePasses, decideAutomationRun, listAutomationApprovals, getAutomationRun, documentOutput, describeDone, startTestRun, latestTestTrigger, sendRunEmail, runScheduledFlow, flowRunsSteps, processHubspotFieldChanges, runFieldChangeAutomation, saveApprovalChoices, testTriggers,
  // RevBox jobs on the engine (GET-868): the box context an AI step reads.
  revboxContextText, revboxRoutineContext, REVBOX_CONTEXT_CHARS,
} from './services/automationRun.mjs';
// Slack layouts for automation output (GET-858): the formats, the AI's JSON shape, parse and text.
export { SLACK_FORMATS, slackFormatOf, structuredSlackFormat, boxSlackFormat, slackFormatInstruction, parseSlackContent, normalizeSlackContent, slackContentText, extractJsonObject } from './services/slackFormats.mjs';
// Record events (GET-559): every detector emits through one door; the trigger worker delivers.
export { emitEvent, buildEventRecord, eventEnvelope, EVENT_API_VERSION } from './services/events.mjs';
// HubSpot fields as automation variables (GET-567): listed from the stored schema, read live.
export { hubspotFieldList, hubspotTemplateVars, hubspotPropsIn } from './services/hubspotVars.mjs';
export {
  createMessage, messageText, parseJsonArray, ModelUnavailableError, registerAnthropicClient,
  pipelineModel, pipelineFallbackModel, writingModel, writingFallbackModel, tierModels, insightBoardModel,
  modelEndpoint, modelRoute, modelSetupStatus,
} from './llm/modelDoor.mjs';
// Deal health — the contextual account score + its signals, shared by the API (account page,
// /v2/deals) and the worker (nightly refresh). Plain JS, carried into dist by allowJs.
export { computeDealHealth, loadHealthInputs, loadHealthHistory, loadAccountHealth, loadNextSteps } from './services/dealHealth.mjs';
// One deal's health from its slice of the account: the deal page and the job that stores a score
// on every open deal row read the same slice, so the board and the page never disagree.
export { sliceDealHealth, claimFiledToDeal, loadDealHealthAccount, loadHealthActivity, lastBuyerResponseAt, dealHealthReason, dealHealthForAccount } from './services/dealHealthSlice.mjs';
export { isEngagementEvent, engagementTrend, medianBuyerResponseDays, multiThread, windowedCounts, ENGAGEMENT_DEFS } from './services/engagement.mjs';
export { DECISION_ROLES, isTwoWay, decisionMakers, committeeRating, computeAccountHealth, selectNextStep, loadAccountHealthScore,
  isTwoWayTouch, twoWayTouches, engagementWindows, GRADE_METER, gradeMeter, loadEngagementActivity } from './services/accountHealthScore.mjs';
export { claimValidAt, accountHealthAsOf, backfillAccountHealth, buildHealthSeries, snapshotPoint, snapshotObservation, hasHistory, recordAccountHealthSnapshot, loadAccountHealthSnapshots, loadAccountHealthTrend, loadAccountCalls, loadCustomerForHealth } from './services/accountHealthHistory.mjs';
// The decision loop, shared the same way: the API writes proposals and verdicts, the worker
// confirms them off ingested sends. Neither app can import from the other's dir, and this
// logic has to be identical on both sides — a second copy of the body-hash normalization is
// exactly how the accept-vs-edit label would rot.
export {
  proposeDecision, recordVerdict, confirmDecision, confirmByAction, listDecisions, summarizeDecisions,
  mirrorDraftAsDecision,
  editMetrics, hashBody, VERDICTS, STATUSES,
} from './db/decisions.mjs';
// Learned instructions — the read that turns what the loop knows into guidance the agent
// receives as context rather than as a report it has to interpret.
export {
  learnedInstructions, renderInstructions, instructionsVersion,
  INSTRUCTION_MIN_N, MAX_RULES,
} from './db/instructions.mjs';
// Constraints — the things this operator does not do. A filter where we generate, the
// hardest-worded block we have where we cannot.
export {
  addConstraint, listConstraints, removeConstraint, bindingConstraints,
  renderConstraints, applies as constraintApplies,
} from './db/constraints.mjs';
// Stated preferences — what someone said, or what one correction made obvious. The sibling of
// ri_observations: those are mined and need n, these were told to us and need none.
export {
  addPreference, listPreferences, removePreference, renderPreferences,
} from './db/preferences.mjs';
// Rules — what a rep said their deals must do (GET-846). Guidance reaches the agent; a checked
// rule is evaluated in the background against the check catalogue.
export {
  buildRuleRow, addRule, listRules, updateRule, removeRule, renderRules,
} from './db/rules.mjs';
export * from './services/ruleChecks.js';
// Deal scoring — P(win), timing and the deal outlook. The revenue forecast that rolls it up
// for a period is Nous Cloud's, in '@nous/core/cloud' (GET-843).
export * from './services/funnelTimeline.js';
export * from './services/winModel.js';
export * from './services/forecast.js';
export * from './services/forecastRun.js';

// Task ownership, resolved late — a commitment names an address, and the seat is bound whenever
// one exists for it. The people who make commitments are usually not users yet (GET-383).
export { seatsByEmail, ownerOfTask, normaliseOwnerEmail } from './services/taskAssignee.js';
export {
  emptyTaskProvenance, provenanceFromModel, matchPersonByName, dealForTask, pickOnlyOpenDeal, companyOfContact,
  type TaskProvenanceFields, type DealLink, type NamedPerson,
} from './services/taskProvenance.js';
export { previousMeetingTasks, carriedOver, retirePreviousMeetingTasks, retireMeetingNotes, meetingTaskKeyRange, type PreviousTask } from './services/meetingReread.js';

// Task closure. It used to live in apps/api and run ONLY as a side effect of opening the Tasks
// page — so a workspace nobody opened never closed a task. One customer sat with nearly every task still open (GET-384).
// Shared here so the page and the scheduled sweep run one implementation, not two.
export { autoCloseActionItems, personNamedIn, promisedAtOf } from './services/actionItemClosure.mjs';
export { hubspotObjects, hubspotObjectFields, readHubspotRecords, summarizeRecords, periodsFor } from './services/hubspotRead.mjs';
export { hubspotFieldChanges, changesFromHistory, changeText } from './services/hubspotFieldTrigger.mjs';

// RevBox configuration and reviewable job proposals (API-first).
export * from "./db/revboxes.mjs";
export * from "./services/revboxPlan.mjs";

export * from './services/revboxCompiler.mjs';
export * from './db/revboxUsage.mjs';

export * from './db/revboxRuns.mjs';
// The Job Builder's sessions and approve -> workflow-engine routine (GET-868).
export * from './db/revboxBuilder.mjs';
export * from './services/revboxExecution.mjs';

export * from './services/routineSchedule.mjs';

export * from './db/customSignals.mjs';
export * from './services/customSignalExtraction.mjs';
// What can start a job (GET-862): built-in + workspace signals, each with its routine trigger.
export * from './services/signalCatalog.mjs';
