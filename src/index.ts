import 'dotenv/config';
import { getEnv } from './get-env';
import type { Issue, IssueConnection, LinearFetch } from '@linear/sdk';
import { LinearClient, WorkflowState } from '@linear/sdk';
import { delay } from './utils';
import asyncPool from 'tiny-async-pool';
import { deflate } from 'pako';
import { fromUint8Array } from 'js-base64';

type NormalizedIssue = {
  identifier: string;
  label: string;
  blockedByIssues: NormalizedIssue[];
};

type NotUndefined<T> = T extends undefined ? never : T;

const ISSUE_PROCESS_CONCURRENCY = 10;

function isDefined<T>(item: NotUndefined<T> | undefined): item is NotUndefined<T> {
  return !!item;
}

function unqiue(issue: string, index: number, array: string[]) {
  return array.indexOf(issue) === index;
}

let apiKey = getEnv('LINEAR_API_KEY');
const linearClient = new LinearClient({ apiKey });

/**
 * log output to stderr (not pipeable)
 */
function log(message: string) {
  console.error(message);
}

/**
 * log output to stdout (pipeable)
 */
function output(message: string) {
  console.log(message);
}

async function getAllIssues(issuesFetcher: LinearFetch<IssueConnection>) {
  let currentPage = await issuesFetcher;

  let nextPage = currentPage;
  while (nextPage.pageInfo.hasNextPage) {
    // don't hammer the Linear API
    await delay(100);

    await nextPage.fetchNext();
    log(`  - ${nextPage.nodes.length}`);
  }

  let nonCanceledIssues = nextPage.nodes.filter(i => !i.canceledAt);
  return nonCanceledIssues;
}

async function normalize(issue: Issue): Promise<NormalizedIssue | undefined> {
  if (await isCanceled(issue)) {
    return;
  }

  let blockedByIssues = await getBlockedByIssues(issue);
  let label = buildLabel(issue);

  return {
    identifier: issue.identifier,
    label,
    blockedByIssues
  };
}

async function getBlockedByIssues(issue: Issue): Promise<NormalizedIssue[]> {
  let relations = await issue.relations();
  let promises = relations.nodes
    .filter(r => r.type === 'blocks')
    .map(r => r.relatedIssue)
    .filter(isDefined);

  let blockedByIssuesRaw = await Promise.all(promises);
  let blockedByIssues = await Promise.all(blockedByIssuesRaw.map(async (i) => {
    if (await isCanceled(i)) {
      return;
    }

    return {
      identifier: i.identifier,
      label: buildLabel(i),
      // we don't need this depth, it's handled by having the full list elsewhere
      blockedByIssues: []
    };
  }));

  return blockedByIssues.filter(isDefined);
}

function buildLabel(issue: Issue) {
  let estimate = issue.estimate || 1;
  return `${issue.identifier}["${issue.identifier}<br/>(${estimate})"]`;
}

function buildLink(graph: string) {
  let mermaidObject = {
    code: graph,
    mermaid: "{\n  \"theme\": \"dark\"\n}",
    autoSync: true,
    updateDiagram: true,
    panZoom: true,
    pan: {
      x: 0,
      y: 0 // 561.4395862465566
    },
    zoom: 1,
    updateEditor: false,
    editorMode: "code",
    rough: false
  };

  const data = new TextEncoder().encode(JSON.stringify(mermaidObject));
  const compressed = deflate(data, { level: 9 });
  let pakoData = fromUint8Array(compressed, true);

  return `https://mermaid.live/edit#pako:${pakoData}`;
}

async function isCanceled(issue: Issue): Promise<boolean> {
  if (issue.canceledAt) {
    return true;
  }

  // for some reason, sometimes `canceledAt` is not set,
  // but the issue is actually canceled

  let state = await issue.state;
  if (state?.type === 'canceled') {
    return true;
  }

  return false;
}

async function processProjectIssues(projectId: string, showActionable: boolean) {
  log('! fetching issues');

  const project = await linearClient.project(projectId);
  const issues = await getAllIssues(project.issues());

  log('! determining workflow');

  let normalizedIssues: NormalizedIssue[] = [];
  for await (const value of asyncPool(ISSUE_PROCESS_CONCURRENCY, issues, normalize)) {
    if (value) {
      normalizedIssues.push(value);
    }
  }

  let blockingList = buildBlockingList(normalizedIssues);

  log('! building graph');

  log('\n------\n');

  let graph = buildGraph(showActionable, normalizedIssues, blockingList);
  output(graph);

  log('------\n');

  log(buildLink(graph));
}

function buildBlockingList(normalizedIssues: NormalizedIssue[]) {
  return normalizedIssues
    .flatMap(i => i.blockedByIssues)
    .flatMap(i => i?.identifier)
    .filter(isDefined)
    .filter(unqiue);
}

function buildGraph(showActionable: boolean, normalizedIssues: NormalizedIssue[], blockingList: string[]) {
  let graph = '';

  graph += 'flowchart LR\n';

  if (showActionable) {
    graph += graphActionable(normalizedIssues, blockingList);
  }
  graph += graphPriority(normalizedIssues, blockingList);
  graph += graphExternal(normalizedIssues);
  graph += graphBlocked(normalizedIssues);
  return graph;
}

function graphBlocked(normalizedIssues: NormalizedIssue[]) {
  let graph = '\nsubgraph blocked\n';
  for (let issue of normalizedIssues) {
    for (let blockerIssue of issue.blockedByIssues) {
      graph += `  ${blockerIssue.label} --> ${issue.label}\n`;
    }
  }
  graph += 'end\n';
  return graph;
}

function graphExternal(normalizedIssues: NormalizedIssue[]) {
  let graph = '\nsubgraph external-blocked-by\n';
  for (let issue of normalizedIssues) {
    for (let blockerIssue of issue.blockedByIssues) {
      let foundInIssueList = normalizedIssues.find(i => i.identifier === blockerIssue.identifier);
      if (foundInIssueList) {
        continue;
      }

      graph += `  ${blockerIssue.label}\n`;
    }
  }
  graph += 'end\n';
  return graph;
}

function graphPriority(normalizedIssues: NormalizedIssue[], blockingList: string[]) {
  let graph = '\nsubgraph priority\n';
  for (let issue of normalizedIssues) {
    if (issue.blockedByIssues.length) {
      // we don't show this here because it needs to appear only in the blocked subgraph
      continue;
    }

    if (!blockingList.includes(issue.identifier)) {
      // exclude what shows up in the actionable subgraph
      continue;
    }

    graph += `  ${issue.label}\n`;
  }
  graph += 'end\n';
  return graph;
}

function graphActionable(normalizedIssues: NormalizedIssue[], blockingList: string[]) {
  let graph = '\nsubgraph actionable\n';
  for (let issue of normalizedIssues) {
    if (issue.blockedByIssues.length) {
      // we don't show this here because it needs to appear only in the blocked subgraph
      continue;
    }

    if (blockingList.includes(issue.identifier)) {
      // this will unblock other issues, which should go in the priority subgraph
      continue;
    }

    graph += `  ${issue.label}\n`;
  }
  graph += 'end\n';
  return graph;
}

async function work() {
  let projectId = process.argv[2];
  let showActionable = process.argv[3] === '--show-actionable';
  await processProjectIssues(projectId, showActionable);
}

work().catch(console.error);
