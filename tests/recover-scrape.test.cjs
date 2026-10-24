const { test } = require('node:test');
const assert = require('node:assert/strict');
const recover = require('../.github/scripts/recover-scrape.cjs');

function fixture(overrides = {}, steps = [{ name: 'Run Senate PTR scraper', conclusion: 'failure' }]) {
  const run = { id: 42, run_attempt: 1, status: 'completed', conclusion: 'failure', head_branch: 'main',
    updated_at: '2026-10-23T13:30:00Z',
    head_repository: { full_name: 'owner/repo' }, event: 'schedule', ...overrides };
  const calls = { reruns: [], warnings: [] };
  const args = {
    context: { repo: { owner: 'owner', repo: 'repo' } },
    now: Date.parse('2026-10-24T01:30:00Z'),
    github: { paginate: async () => [{ name: 'scrape', steps }], rest: { actions: {
      listJobsForWorkflowRun: () => {},
      listWorkflowRuns: async () => ({ data: { workflow_runs: [run] } }),
      getWorkflowRun: async () => ({ data: { status: 'completed', ...run } }),
      reRunWorkflowFailedJobs: async value => calls.reruns.push(value),
    } } },
    core: { info: () => {}, warning: value => calls.warnings.push(value) },
  };
  return { args, calls };
}

test('evening check retries an eligible failure from twelve hours ago', async () => {
  const { args, calls } = fixture();
  await recover(args);
  assert.deepEqual(calls.reruns, [{ owner: 'owner', repo: 'repo', run_id: 42 }]);
});
test('only one delayed recovery attempt is allowed', async () => {
  const { args, calls } = fixture({ run_attempt: 2 });
  await recover(args);
  assert.equal(calls.reruns.length, 0);
});
test('recent, stale, and unknown failure timestamps cannot trigger retries', async () => {
  for (const updated_at of ['2026-10-24T00:00:00Z', '2026-10-22T00:00:00Z', 'invalid']) {
    const { args, calls } = fixture({ updated_at });
    await recover(args);
    assert.equal(calls.reruns.length, 0);
  }
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
  for (const override of [{ conclusion: 'success' }, { status: 'in_progress' }, { head_repository: { full_name: 'fork/repo' } },
    { head_branch: 'feature' }, { event: 'pull_request' }]) {
    const { args, calls } = fixture(override);
    await recover(args);
    assert.equal(calls.reruns.length, 0);
  }
});
test('a concurrent manual rerun prevents a duplicate retry', async () => {
  const { args, calls } = fixture();
  args.github.rest.actions.getWorkflowRun = async () => ({ data: { status: 'in_progress', run_attempt: 2 } });
  await recover(args);
  assert.equal(calls.reruns.length, 0);
});
test('no previous run does not trigger recovery', async () => {
  const { args, calls } = fixture();
  args.github.rest.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: [] } });
  await recover(args);
  assert.equal(calls.reruns.length, 0);
});
