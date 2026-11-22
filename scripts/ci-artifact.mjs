import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, copyFile, lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const artifactDirectory = 'ci-deploy-artifact';
const manifestName = 'provenance.json';
const workflowPath = '.github/workflows/ci.yml';
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const jarPattern = /^ec-site-[A-Za-z0-9][A-Za-z0-9._-]*\.jar$/u;

function requireThat(condition, message) {
  if (!condition) throw new Error('CI artifact: ' + message);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function environmentInteger(value) {
  requireThat(typeof value === 'string' && /^[1-9][0-9]*$/u.test(value), 'missing numeric producer identity');
  const number = Number(value);
  requireThat(positiveInteger(number), 'invalid numeric producer identity');
  return number;
}

function assertCheckout(root, sha) {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  requireThat(actual === sha, 'checkout does not match the successful CI commit');
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
    cwd: root, encoding: 'utf8',
  });
  requireThat(status.trim() === '', 'tracked checkout files changed');
}

async function regularFile(file) {
  const stat = await lstat(file);
  requireThat(stat.isFile() && !stat.isSymbolicLink(), 'artifact entry must be a regular file');
  return stat;
}

async function fileDigest(file) {
  await regularFile(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return 'sha256:' + hash.digest('hex');
  } finally { await handle.close(); }
}

function sameProducer(actual, expected) {
  return ['repository', 'repositoryId', 'runId', 'runAttempt', 'headSha', 'event', 'branch', 'workflow']
    .every(key => actual[key] === expected[key]);
}

export function producerFromEvent(context) {
  const repository = context.payload?.repository;
  const run = context.payload?.workflow_run;
  const fullName = context.repo?.owner + '/' + context.repo?.repo;
  requireThat(context.eventName === 'workflow_run' && context.payload?.action === 'completed', 'automatic reuse requires a completed workflow_run');
  requireThat(repository?.full_name === fullName && positiveInteger(repository?.id)
    && repository.default_branch === 'main', 'unexpected repository or default branch');
  requireThat(run?.event === 'push' && run.status === 'completed' && run.conclusion === 'success'
    && run.head_branch === 'main', 'producer must be a successful main push');
  requireThat(run.head_repository?.id === repository.id && run.head_repository.full_name === fullName,
    'fork or different producer repository');
  requireThat(positiveInteger(run.id) && positiveInteger(run.run_attempt) && shaPattern.test(run.head_sha ?? ''),
    'invalid producer run, attempt or commit');
  return {
    repository: fullName, repositoryId: repository.id, runId: run.id, runAttempt: run.run_attempt,
    headSha: run.head_sha, event: 'push', branch: 'main', workflow: workflowPath,
  };
}

export async function currentProducer({ github, context }) {
  const expected = producerFromEvent(context);
  const repository = { owner: context.repo.owner, repo: context.repo.repo };
  const [runResponse, workflowResponse, repositoryResponse, branchResponse] = await Promise.all([
    github.rest.actions.getWorkflowRun({ ...repository, run_id: expected.runId }),
    github.rest.actions.getWorkflow({ ...repository, workflow_id: 'ci.yml' }),
    github.rest.repos.get(repository),
    github.rest.repos.getBranch({ ...repository, branch: 'main' }),
  ]);
  const run = runResponse.data;
  const workflow = workflowResponse.data;
  const repo = repositoryResponse.data;
  requireThat(repo.id === expected.repositoryId && repo.full_name === expected.repository
    && repo.default_branch === 'main', 'repository identity or default branch changed');
  requireThat(workflow.path === workflowPath && workflow.name === 'CI' && workflow.state === 'active'
    && run.workflow_id === workflow.id && run.path === workflowPath, 'unexpected producer workflow');
  requireThat(run.id === expected.runId && run.run_attempt === expected.runAttempt
    && run.head_sha === expected.headSha && run.head_branch === 'main'
    && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success',
    'producer run or attempt is no longer the successful event');
  requireThat(run.repository?.id === expected.repositoryId && run.repository.full_name === expected.repository
    && run.head_repository?.id === expected.repositoryId && run.head_repository.full_name === expected.repository,
    'producer repository identity mismatch');
  requireThat(branchResponse.data.name === 'main' && branchResponse.data.commit?.sha === expected.headSha,
    'producer commit has been superseded on main; wait for the newer CI or use the explicit manual path');
  return expected;
}

export async function selectArtifact({ github, context }) {
  const producer = await currentProducer({ github, context });
  const expectedName = `ec-site-jar-${producer.runId}-${producer.runAttempt}`;
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner: context.repo.owner, repo: context.repo.repo, run_id: producer.runId, per_page: 100,
  });
  const matches = artifacts.filter(item => item.name === expectedName);
  requireThat(matches.length === 1, 'exact producer artifact is missing or ambiguous; no rebuild fallback');
  const artifact = matches[0];
  requireThat(positiveInteger(artifact.id) && artifact.expired === false && artifact.size_in_bytes > 0
    && digestPattern.test(artifact.digest ?? ''), 'artifact expired, empty or missing its digest');
  requireThat(artifact.workflow_run?.id === producer.runId
    && artifact.workflow_run.repository_id === producer.repositoryId
    && artifact.workflow_run.head_repository_id === producer.repositoryId
    && artifact.workflow_run.head_branch === 'main'
    && artifact.workflow_run.head_sha === producer.headSha, 'artifact producer metadata mismatch');
  return { producer, artifactId: artifact.id, artifactName: expectedName, artifactDigest: artifact.digest };
}

export async function prepareArtifact({ root = process.cwd(), environment = process.env } = {}) {
  const repository = environment.GITHUB_REPOSITORY;
  const sha = environment.GITHUB_SHA;
  requireThat(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    && shaPattern.test(sha ?? ''), 'invalid build repository or commit');
  requireThat(environment.GITHUB_EVENT_NAME === 'push' && environment.GITHUB_REF === 'refs/heads/main'
    && environment.GITHUB_WORKFLOW === 'CI'
    && environment.GITHUB_WORKFLOW_REF === repository + '/' + workflowPath + '@refs/heads/main',
    'only the main push CI may publish deployment artifacts');
  const producer = {
    repository, repositoryId: environmentInteger(environment.GITHUB_REPOSITORY_ID),
    runId: environmentInteger(environment.GITHUB_RUN_ID),
    runAttempt: environmentInteger(environment.GITHUB_RUN_ATTEMPT),
    headSha: sha, event: 'push', branch: 'main', workflow: workflowPath,
  };
  assertCheckout(root, sha);
  const target = path.join(root, 'target');
  const jars = (await readdir(target)).filter(name => name.endsWith('.jar'));
  requireThat(jars.length === 1 && jarPattern.test(jars[0]), 'build must produce exactly one versioned ec-site JAR');
  await regularFile(path.join(target, jars[0]));
  const destination = path.join(root, artifactDirectory);
  await mkdir(destination); // Existing bundles are stale evidence, never overwritten.
  const jar = path.join(destination, jars[0]);
  await copyFile(path.join(target, jars[0]), jar);
  const stat = await regularFile(jar);
  requireThat(stat.size > 0, 'build produced an empty JAR');
  const manifest = { schemaVersion: 1, producer,
    jar: { name: jars[0], bytes: stat.size, sha256: await fileDigest(jar) } };
  await writeFile(path.join(destination, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { manifest, artifactName: `ec-site-jar-${producer.runId}-${producer.runAttempt}` };
}

export async function verifyBundle({ directory, selected }) {
  requireThat(positiveInteger(selected?.artifactId) && digestPattern.test(selected?.artifactDigest ?? ''),
    'missing trusted artifact selection');
  const producer = selected.producer;
  requireThat(selected.artifactName === `ec-site-jar-${producer?.runId}-${producer?.runAttempt}`,
    'artifact name does not bind the selected run attempt');
  const stat = await lstat(directory);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'artifact directory must not be a symlink');
  const entries = await readdir(directory);
  const manifestPath = path.join(directory, manifestName);
  const manifestStat = await regularFile(manifestPath);
  requireThat(manifestStat.size > 0 && manifestStat.size < 65_536, 'invalid artifact manifest size');
  const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest;
  try {
    try { manifest = JSON.parse(await handle.readFile('utf8')); }
    catch { throw new Error('CI artifact: invalid artifact manifest'); }
  } finally { await handle.close(); }
  requireThat(manifest?.schemaVersion === 1 && manifest.producer && sameProducer(manifest.producer, producer),
    'manifest does not match the trusted producer');
  requireThat(jarPattern.test(manifest.jar?.name ?? '') && positiveInteger(manifest.jar?.bytes)
    && digestPattern.test(manifest.jar?.sha256 ?? ''), 'invalid JAR manifest');
  requireThat(entries.length === 2 && entries.includes(manifestName) && entries.includes(manifest.jar.name),
    'bundle must contain only its manifest and one JAR');
  const jarPath = path.join(directory, manifest.jar.name);
  const jarStat = await regularFile(jarPath);
  requireThat(jarStat.size === manifest.jar.bytes && await fileDigest(jarPath) === manifest.jar.sha256,
    'JAR bytes do not match the producer manifest');
  return { manifest, jarPath };
}

export async function stageArtifact({ root = process.cwd(), selected, destinationName = null }) {
  const verified = await verifyBundle({ directory: path.join(root, artifactDirectory), selected });
  assertCheckout(root, selected.producer.headSha);
  requireThat(destinationName === null || destinationName === 'ec-site.jar', 'unexpected deployment filename');
  const target = path.join(root, 'target');
  await mkdir(target); // A previous build must never supply an extra wildcard match.
  const destination = path.join(target, destinationName ?? verified.manifest.jar.name);
  await copyFile(verified.jarPath, destination);
  requireThat(await fileDigest(destination) === verified.manifest.jar.sha256, 'staged JAR digest mismatch');
  return { file: path.relative(root, destination), sha256: verified.manifest.jar.sha256 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...extra] = process.argv.slice(2);
  requireThat(extra.length === 0, 'unexpected command arguments');
  if (command === 'prepare') {
    const result = await prepareArtifact();
    requireThat(typeof process.env.GITHUB_OUTPUT === 'string', 'missing workflow output file');
    await appendFile(process.env.GITHUB_OUTPUT, `artifact-name=${result.artifactName}\n`);
  } else {
    throw new Error('CI artifact: expected prepare command');
  }
}
