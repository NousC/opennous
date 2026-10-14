-- Run against a throwaway database with schema.sql loaded.
BEGIN;
INSERT INTO teams(id,name) VALUES('11111111-1111-4111-8111-111111111111','Test');
INSERT INTO users(id,email,team_id) VALUES('22222222-2222-4222-8222-222222222222','revbox-test@example.test','11111111-1111-4111-8111-111111111111');
INSERT INTO workspaces(id,team_id,name) VALUES('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','Test');
INSERT INTO revboxes(id,workspace_id,owner_id) VALUES('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222');
SELECT record_revbox_usage('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444',NULL,NULL,'revbox-plan','test','{"input_tokens":10,"output_tokens":5}',0.02,'revbox-test-paid-call');
SELECT record_revbox_usage('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444',NULL,NULL,'revbox-plan','test','{"input_tokens":10,"output_tokens":5}',0.02,'revbox-test-paid-call');
DO $$ BEGIN
 IF (SELECT count(*) FROM llm_usage WHERE request_id='revbox-test-paid-call')<>1 THEN RAISE EXCEPTION 'Duplicate billing'; END IF;
 IF (SELECT count(*) FROM revbox_usage WHERE request_id='revbox-test-paid-call')<>1 THEN RAISE EXCEPTION 'Duplicate attribution'; END IF;
 BEGIN
   PERFORM record_revbox_usage('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','55555555-5555-4555-8555-555555555555',NULL,NULL,'revbox-plan','test','{}',0.02,'revbox-test-failed-call');
   RAISE EXCEPTION 'Invalid box accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 IF EXISTS(SELECT 1 FROM llm_usage WHERE request_id='revbox-test-failed-call') THEN RAISE EXCEPTION 'Failed attribution charged'; END IF;
END $$;
INSERT INTO revbox_jobs(id,workspace_id,revbox_id,created_by,name,prompt,plan,state,enabled)
 VALUES('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','Campaign analysis','Analyze','{"trigger":{"kind":"campaign_completed"}}','reviewed',true);
INSERT INTO campaign_stats(workspace_id,provider,campaign_id,status) VALUES('33333333-3333-4333-8333-333333333333','instantly','test-campaign',1);
UPDATE campaign_stats SET status=3 WHERE campaign_id='test-campaign';
UPDATE campaign_stats SET status=3 WHERE campaign_id='test-campaign';
DO $$ BEGIN
 IF (SELECT count(*) FROM revbox_events WHERE workspace_id='33333333-3333-4333-8333-333333333333' AND type='campaign.completed')<>1 THEN RAISE EXCEPTION 'Campaign completion did not deduplicate'; END IF;
END $$;
ROLLBACK;
