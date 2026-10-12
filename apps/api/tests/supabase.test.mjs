/**
 * Direct Supabase connectivity tests — verifies the DB connection and
 * that expected tables exist. Skipped if credentials are absent.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { stopServer, hasSupabase } from './helpers.mjs';

after(stopServer);

function skip(name, fn) {
  if (hasSupabase) return test(name, fn);
  test(name, { skip: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }, fn);
}

// Import after env is loaded by helpers
let supabase;
skip('Supabase client connects successfully', async () => {
  const { getSupabaseClient } = await import('@nous/core');
  supabase = getSupabaseClient();
  assert.ok(supabase, 'client should be created');
});

skip('workspaces table is accessible', async () => {
  const { error } = await supabase.from('workspaces').select('id').limit(1);
  assert.equal(error, null, `workspaces query failed: ${error?.message}`);
});

skip('contacts table is accessible', async () => {
  const { error } = await supabase.from('contacts').select('id').limit(1);
  assert.equal(error, null, `contacts query failed: ${error?.message}`);
});


skip('companies table is accessible', async () => {
  const { error } = await supabase.from('companies').select('id').limit(1);
  assert.equal(error, null, `companies query failed: ${error?.message}`);
});

skip('api_keys table is accessible', async () => {
  const { error } = await supabase.from('api_keys').select('id').limit(1);
  assert.equal(error, null, `api_keys query failed: ${error?.message}`);
});

skip('teams table is accessible', async () => {
  const { error } = await supabase.from('teams').select('id').limit(1);
  assert.equal(error, null, `teams query failed: ${error?.message}`);
});

skip('users table is accessible', async () => {
  const { error } = await supabase.from('users').select('id').limit(1);
  assert.equal(error, null, `users query failed: ${error?.message}`);
});

skip('subscriptions table is accessible', async () => {
  const { error } = await supabase.from('subscriptions').select('id').limit(1);
  assert.equal(error, null, `subscriptions query failed: ${error?.message}`);
});

skip('workspace_system_log.billable_ops column exists', async () => {
  const { error } = await supabase.from('workspace_system_log').select('id, billable_ops').limit(1);
  assert.equal(error, null, `billable_ops column missing: ${error?.message}`);
});
