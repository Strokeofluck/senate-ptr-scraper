module.exports = async function recover({ github, context, core, now = Date.now() }) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo, workflow_id: 'scrape.yml', branch: 'main', per_page: 1,
  });
  const run = data.workflow_runs[0];
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (!run || run.status !== 'completed' || run.conclusion !== 'failure' || run.head_branch !== 'main' ||
      run.head_repository?.full_name !== repository ||
      !['schedule', 'workflow_dispatch'].includes(run.event)) return;

  const age = now - Date.parse(run.updated_at);
  if (!Number.isFinite(age) || age < 6 * 3600000 || age > 24 * 3600000) return;
  if (run.run_attempt >= 2) {
    core.info('The one recovery attempt is already used; leaving the source alone until the next daily run.');
    return;
  }

  const args = { ...context.repo, run_id: run.id };
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...args, filter: 'latest', per_page: 100,
  });
  const scraperFailed = jobs.some(job => job.name === 'scrape' &&
    job.steps?.some(step => step.name === 'Run Senate PTR scraper' && step.conclusion === 'failure'));
  // Never replay commits or downstream rebuilds because a later step failed.
  if (!scraperFailed) return;
  // Recheck in case somebody started a manual rerun while we inspected the jobs.
  const { data: current } = await github.rest.actions.getWorkflowRun(args);
  if (current.status !== 'completed' || current.conclusion !== 'failure' ||
      current.run_attempt !== run.run_attempt) return;

  await github.rest.actions.reRunWorkflowFailedJobs(args);
  core.info('Queued the single delayed recovery attempt on a fresh runner.');
};
