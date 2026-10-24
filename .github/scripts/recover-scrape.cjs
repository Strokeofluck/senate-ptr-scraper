module.exports = async function recover({ github, context, core, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const run = context.payload.workflow_run;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (run.conclusion !== 'failure' || run.head_branch !== 'main' ||
      run.head_repository?.full_name !== repository ||
      !['schedule', 'workflow_dispatch'].includes(run.event)) return;

  const args = { ...context.repo, run_id: run.id };
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...args, filter: 'latest', per_page: 100,
  });
  const scraperFailed = jobs.some(job => job.name === 'scrape' &&
    job.steps?.some(step => step.name === 'Run Senate PTR scraper' && step.conclusion === 'failure'));
  // Never replay commits or downstream rebuilds because a later step failed.
  if (!scraperFailed) return;
  if (run.run_attempt >= 3) {
    core.warning('Senate scrape failed after 3 runner attempts. Existing published data is unchanged; inspect the scrape logs.');
    return;
  }

  const delay = run.run_attempt === 1 ? 120000 : 600000;
  core.info(`Waiting ${delay / 1000}s before retrying the Senate scrape on a fresh runner.`);
  await sleep(delay);
  const { data: current } = await github.rest.actions.getWorkflowRun(args);
  if (current.status !== 'completed' || current.conclusion !== 'failure' ||
      current.run_attempt !== run.run_attempt) return;

  await github.rest.actions.reRunWorkflowFailedJobs(args);
  core.info(`Queued Senate scrape attempt ${run.run_attempt + 1} of 3.`);
};
