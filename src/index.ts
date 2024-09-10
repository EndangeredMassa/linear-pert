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

function log(message: string) {
  console.log(message);
}

async function getAllIssues(issuesFetcher: LinearFetch<IssueConnection>) {
  let currentPage = await issuesFetcher;

  let nextPage = currentPage;
  while (nextPage.pageInfo.hasNextPage) {
    // don't hammer the Linear API
    await delay(100);

    await nextPage.fetchNext();
    console.log(`  - ${nextPage.nodes.length}`);
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
  return `${issue.identifier}["\`${issue.identifier}\n(${estimate})\`"]`;
}

function buildLink(graph: string) {
  // https://mermaid.live/edit#pako:eNqN0kFrwyAUB_CvEt5pg7RojJp42Gm7DQbdrXNQm9g1NNGQGrau9LvPDrpIcdCbf_m9x_PhESpbaxCwae1ntVWDS54X0uzH9ceg-m2iKtdYo9atliZJlk-Ll1lGMXuTsPoL0tzh-5WE94AgHBCEIySndCI-RAhmfCI-RAii2UR88CS_JrwMCC9j42Iavig2CyLBLD5ECQtJuBdt6mCp_dDYoXGHsLQIS4t_S9etrXa6vqEymc0eLiZHgclRdPYb2pBwkeS8SDoNCSl0euhUU_vfdDx3luC2utMShD_WathJkObknRqdfT2YCoQbRp3C2NfK6cdG-Td2IDaq3fvbXpmltd0F-QjiCF8gGJvnGc8J5QxTmpUshQMIXKI55xknhHGEswLRUwrfvw3QvECc4DzDHJWIIcZPP_LT19M
  // https://mermaid.live/edit#base64:eyJjb2RlIjoiY2xhc3NEaWFncmFtXG4gICAgQW5pbWFsIDx8LS0gRHVja1xuICAgIEFuaW1hbCA8fC0tIEZpc2hcbiAgICBBbmltYWwgPHwtLSBaZWJyYVxuICAgIEFuaW1hbCA6ICtpbnQgYWdlXG4gICAgQW5pbWFsIDogK1N0cmluZyBnZW5kZXJcbiAgICBBbmltYWw6ICtpc01hbW1hbCgpXG4gICAgQW5pbWFsOiArbWF0ZSgpXG4gICAgY2xhc3MgRHVja3tcbiAgICAgICtTdHJpbmcgYmVha0NvbG9yXG4gICAgICArc3dpbSgpXG4gICAgICArcXVhY2soKVxuICAgIH1cbiAgICBjbGFzcyBGaXNoe1xuICAgICAgLWludCBzaXplSW5GZWV0XG4gICAgICAtY2FuRWF0KClcbiAgICB9XG4gICAgY2xhc3MgWmVicmF7XG4gICAgICArYm9vbCBpc193aWxkXG4gICAgICArcnVuKClcbiAgICB9XG4gICAgICAgICAgICAiLCJtZXJtYWlkIjoie1xuICBcInRoZW1lXCI6IFwiZGVmYXVsdFwiXG59IiwidXBkYXRlRWRpdG9yIjpmYWxzZSwiYXV0b1N5bmMiOnRydWUsInVwZGF0ZURpYWdyYW0iOmZhbHNlfQ

  /*
  {
    "code": "flowchart LR\nsubgraph actionable\n  ZERO-2516[\"`ZERO-2516\n(1)`\"]\n  ZERO-2515[\"`ZERO-2515\n(1)`\"]\n  ZERO-2079[\"`ZERO-2079\n(1)`\"]\n  ZERO-2052[\"`ZERO-2052\n(4)`\"]\n  ZERO-2501[\"`ZERO-2501\n(1)`\"]\n  ZERO-2167[\"`ZERO-2167\n(1)`\"]\n  ZERO-2037[\"`ZERO-2037\n(1)`\"]\n  ZERO-2036[\"`ZERO-2036\n(1)`\"]\n  ZERO-2455[\"`ZERO-2455\n(1)`\"]\nend\nsubgraph priority\n  ZERO-2038[\"`ZERO-2038\n(1)`\"]\nend\nsubgraph blocked\n  ZERO-2038[\"`ZERO-2038\n(1)`\"] --> ZERO-2040[\"`ZERO-2040\n(1)`\"]\n  ZERO-2038[\"`ZERO-2038\n(1)`\"] --> ZERO-2039[\"`ZERO-2039\n(5)`\"]\nend\n",
    "mermaid": "{\n  \"theme\": \"dark\"\n}",
    "autoSync": true,
    "updateDiagram": true,
    "panZoom": true,
    "pan": {
      "x": 0,
      "y": 561.4395862465566
    },
    "zoom": 1,
    "updateEditor": false,
    "editorMode": "code",
    "rough": false
  }
  */

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

  log('! building graph');

  log('\n------\n');

  let graph = '';

  let blockingList = normalizedIssues
    .flatMap(i => i.blockedByIssues)
    .flatMap(i => i?.identifier)
    .filter(isDefined)
    .filter(unqiue);


  graph += 'flowchart LR\n';


  if (showActionable) {
    graph += 'subgraph actionable\n';
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
  }


  graph += 'subgraph priority\n';
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


  graph += 'subgraph external-blocked-by\n';
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


  graph += 'subgraph blocked\n';
  for (let issue of normalizedIssues) {
    for (let blockerIssue of issue.blockedByIssues) {
      graph += `  ${blockerIssue.label} --> ${issue.label}\n`;
    }
  }
  graph += 'end\n';


  log(graph);

  log('------\n');

  log(buildLink(graph));
}

async function work() {
  let projectId = process.argv[2];
  let showActionable = process.argv[3] === '--show-actionable';
  await processProjectIssues(projectId, showActionable);
}

work().catch(console.error);
