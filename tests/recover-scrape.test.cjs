const { test } = require('node:test');
const assert = require('node:assert/strict');
const recover = require('../.github/scripts/recover-scrape.cjs');

function fixture(overrides = {}, steps = [{ name: 'Run Senate PTR scraper', conclusion: 'failure' }]) {
  const run = { id: 42, run_attempt: 1, conclusion: 'failure', head_branch: 'main',
    head_repository: { full_name: 'owner/repo' }, event: 'schedule', ...overrides };
  const calls = { reruns: [], delays: [], warnings: [] };
  const args = {
    context: { repo: { owner: 'owner', repo: 'repo' }, payload: { workflow_run: run } },
    github: { paginate: async () => [{ name: 'scrape', steps }], rest: { actions: {
      listJobsForWorkflowRun: () => {},
      getWorkflowRun: async () => ({ data: { status: 'completed', ...run } }),
      reRunWorkflowFailedJobs: async value => calls.reruns.push(value),
    } } },
    core: { info: () => {}, warning: value => calls.warnings.push(value) },
    sleep: async delay => calls.delays.push(delay),
  };
  return { args, calls };
}

test('source failure retries on a fresh runner after cooldown', async () => {
  const { args, calls } = fixture();
  await recover(args);
  assert.deepEqual(calls.delays, [120000]);
  assert.deepEqual(calls.reruns, [{ owner: 'owner', repo: 'repo', run_id: 42 }]);
});
test('second failure uses a longer cooldown', async () => {
  const { args, calls } = fixture({ run_attempt: 2 });
  await recover(args);
  assert.deepEqual(calls.delays, [600000]);
  assert.equal(calls.reruns.length, 1);
});
test('third attempt cannot create an infinite retry loop', async () => {
  const { args, calls } = fixture({ run_attempt: 3 });
  await recover(args);
  assert.equal(calls.warnings.length, 1);
  assert.equal(calls.reruns.length, 0);
  assert.equal(calls.delays.length, 0);
});
test('commit or downstream notification failures are not replayed', async () => {
  const { args, calls } = fixture({}, [
    { name: 'Run Senate PTR scraper', conclusion: 'success' },
    { name: 'Notify sean-data-portfolio to rebuild', conclusion: 'failure' },
  ]);
  await recover(args);
  assert.equal(calls.reruns.length, 0);
});
test('success, fork, branch, and pull request events cannot request retries', async () => {
  for (const override of [{ conclusion: 'success' }, { head_repository: { full_name: 'fork/repo' } },
    { head_branch: 'feature' }, { event: 'pull_request' }]) {
    const { args, calls } = fixture(override);
    await recover(args);
    assert.equal(calls.reruns.length, 0);
    assert.equal(calls.delays.length, 0);
  }
});
test('a manual rerun during cooldown prevents a duplicate retry', async () => {
  const { args, calls } = fixture();
  args.github.rest.actions.getWorkflowRun = async () => ({ data: { status: 'in_progress', run_attempt: 2 } });
  await recover(args);
  assert.equal(calls.reruns.length, 0);
});
