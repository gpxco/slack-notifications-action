
const axios = require('axios');
const core = require('@actions/core');
const fs = require('fs');
const github = require('@actions/github');
const os = require('os');

let slackWebhookUrl;

function getBaseSlackMessage() {

  const slackChannel = core.getInput('channel') || '#app-log';
  const slackUsername = core.getInput('username') || 'Github Actions';
  const slackIcon = core.getInput('icon') || ':octocat:';

  let actorAvatarUrl = `https://avatars.githubusercontent.com/${process.env.GITHUB_ACTOR}`;
  if ('payload' in github.context &&
      'sender' in github.context.payload &&
      'avatar_url' in github.context.payload.sender
  ) {
    actorAvatarUrl = github.context.payload.sender.avatar_url;
  }

  let repositoryLink = `https://github.com/${process.env.GITHUB_REPOSITORY}`;
  if (github.context.ref.indexOf('refs/heads/') === 0) {
    repositoryLink += `/tree/${github.context.ref.replace('refs/heads/', '')}`;
  }

  const shortSha = github.context.sha.substr(0, 6);

  return {
    'channel': slackChannel,
    'username': slackUsername,
    'icon_emoji': slackIcon,
    'attachments': [
      {
        'author_name': process.env.GITHUB_ACTOR,
        'author_icon': actorAvatarUrl,
        'text': null,
        'footer': `<${repositoryLink}|${process.env.GITHUB_REPOSITORY} @ ${shortSha}>`,
        'footer_icon': 'https://github.githubassets.com/favicon.ico'
      }
    ],
    'mrkdwn': true
  };
}

function getWorkflowSlackLink() {
  return `<https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${github.context.runId}|${github.context.workflow}>`;
}

function sendStartingMessage(slackMessage) {
  const workflowLink = getWorkflowSlackLink();
  slackMessage.attachments[0]['text'] = `Starting *${workflowLink}* workflow`;
  return sendSlackMessage(slackMessage);
}

function sendSuccessMessage(slackMessage) {
  const workflowLink = getWorkflowSlackLink();
  slackMessage.attachments[0]['text'] = `Finished *${workflowLink}* workflow successfully`;
  slackMessage.attachments[0]['color'] = 'good';
  return sendSlackMessage(slackMessage);
}

function sendFailedMessage(slackMessage, failedId, failedJob, failedStep) {
  const workflowLink = getWorkflowSlackLink();
  slackMessage.attachments[0]['text'] = `Workflow *${workflowLink} failed* during job <https://github.com/${process.env.GITHUB_REPOSITORY}/runs/${failedId}|${failedJob}> at step \`${failedStep}\``;
  slackMessage.attachments[0]['color'] = '#e60000';
  return sendSlackMessage(slackMessage);
}

function sendCancelledMessage(slackMessage) {
  const workflowLink = getWorkflowSlackLink();
  slackMessage.attachments[0]['text'] = `Workflow *${workflowLink} cancelled*`;
  slackMessage.attachments[0]['color'] = 'warning';
  return sendSlackMessage(slackMessage);
}

function sendSlackMessage(slackMessage) {
  return axios
    .post(slackWebhookUrl, slackMessage)
    .then(res => {
      console.log('Slack message sent');
    })
    .catch(error => {
      console.log('Failed to send Slack message, but not blocking workflow');
    });
}

function getWorkflowConclusion(jobs) {

  let result = {
    conclusion: 'success',
    failedId: null,
    failedJob: null,
    failedStep: null
  };

  for (let job of jobs) {

    // If the job is NOT completed, it _should_ be *this* job, so ignore
    if (job.status != 'completed') {
      continue;
    }

    // We consider anything but a successful conclusion as a failure. We could
    // in theory have multiple failed steps, especially in parallel, but we
    // only really care about the first one for our use case
    if (job.conclusion != 'success') {

      result.conclusion = 'failure';
      result.failedId = job.id;
      result.failedJob = job.name;

      for (let step of job.steps) {
        if (step.conclusion != 'success') {
          result.failedStep = step.name;
          break;
        }
      }

      // Specifically handle a "cancelled" conclusion
      if (job.conclusion == 'cancelled') {
        result.conclusion = 'cancelled';
      }

      break;
    }
  }

  return result;
}

async function main() {

  // Action inputs
  slackWebhookUrl = core.getInput('webhookUrl', { required: true });
  const workflowIsStarting = core.getInput('starting') == 'true';
  core.setSecret(slackWebhookUrl);

  // Define the default Slack message structure
  let slackMessage = getBaseSlackMessage();

  // Starting message
  if (workflowIsStarting) {
    return sendStartingMessage(slackMessage);
  }

  // Get the Github API token
  const githubToken = core.getInput('githubToken', { required: true });
  core.setSecret(githubToken);

  // Get the data for the workflow jobs
  const octokit = github.getOctokit(githubToken);
  const githubRepositoryOwner = process.env.GITHUB_REPOSITORY.split('/')[0];
  const githubRepositoryName = process.env.GITHUB_REPOSITORY.split('/')[1];
  const workflowJobsData = await octokit.rest.actions.listJobsForWorkflowRun({
    'owner': githubRepositoryOwner,
    'repo': githubRepositoryName,
    'run_id': github.context.runId,
  });

  const workflowConclusion = getWorkflowConclusion(workflowJobsData.data.jobs);

  switch (workflowConclusion.conclusion) {
    case 'failure':
      return sendFailedMessage(
        slackMessage,
        workflowConclusion.failedId,
        workflowConclusion.failedJob,
        workflowConclusion.failedStep
      );
      break;
    case 'cancelled':
      return sendCancelledMessage(slackMessage);
      break;
    case 'success':
      return sendSuccessMessage(slackMessage);
      break;
    default:
      console.log('Unknown workflow conclusion', workflowJobsData.data.jobs);
  }
}

function handleError(error) {
  console.error(error);
  if (error && error.message) {
    core.setFailed(error.message)
  } else {
    core.setFailed(`Unhandled Error: ${error}`);
  }
}

process.on('unhandledRejection', handleError);
main().catch(handleError);