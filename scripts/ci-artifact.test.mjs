import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { artifactDirectory, currentProducer, prepareArtifact, selectArtifact, stageArtifact, verifyBundle } from './ci-artifact.mjs';

const helper = fileURLToPath(new URL('./ci-artifact.mjs', import.meta.url));
const sha = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);
const clone = value => structuredClone(value);

function apiFixture() {
  const repo = { id: 10, full_name: 'fixture-owner/ec-site-java', default_branch: 'main' };
  const run = { id: 20, run_attempt: 2, head_sha: sha, head_branch: 'main', event: 'push',
    status: 'completed', conclusion: 'success', workflow_id: 40, path: '.github/workflows/ci.yml',
    repository: clone(repo), head_repository: clone(repo) };
  const artifact = { id: 30, name: 'ec-site-jar-20-2', expired: false, size_in_bytes: 100,
    digest, workflow_run: { id: 20, repository_id: 10, head_repository_id: 10,
      head_branch: 'main', head_sha: sha } };
  const data = { repo, run, workflow: { id: 40, path: '.github/workflows/ci.yml', name: 'CI', state: 'active' },
    branch: { name: 'main', commit: { sha } }, artifacts: [artifact] };
  const context = { eventName: 'workflow_run', repo: { owner: 'fixture-owner', repo: 'ec-site-java' },
    payload: { action: 'completed', repository: clone(repo), workflow_run: clone(run) } };
  const calls = [];
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async args => { calls.push(['run', args]); return { data: clone(data.run) }; },
        getWorkflow: async args => { calls.push(['workflow', args]); return { data: clone(data.workflow) }; },
        listWorkflowRunArtifacts: () => { throw new Error('must paginate'); },
      },
      repos: {
        get: async args => { calls.push(['repository', args]); return { data: clone(data.repo) }; },
        getBranch: async args => { calls.push(['branch', args]); return { data: clone(data.branch) }; },
      },
    },
    paginate: async (method, args) => {
      assert.equal(method, github.rest.actions.listWorkflowRunArtifacts);
      calls.push(['artifacts', args]);
      return clone(data.artifacts);
    },
  };
  return { data, context, github, calls };
}

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'ec-site-artifact-test-'));
  const environment = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = args => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']);
  await writeFile(path.join(root, 'README.md'), 'Non-sensitive local fixture.\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture']);
  const head = git(['rev-parse', 'HEAD']);
  await mkdir(path.join(root, 'target'));
  await writeFile(path.join(root, 'target/ec-site-0.0.1-SNAPSHOT.jar'), 'PK synthetic non-executable JAR bytes\n');
  Object.assign(environment, {
    GITHUB_REPOSITORY: 'fixture-owner/ec-site-java', GITHUB_REPOSITORY_ID: '10',
    GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: head,
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW: 'CI',
    GITHUB_WORKFLOW_REF: 'fixture-owner/ec-site-java/.github/workflows/ci.yml@refs/heads/main',
    GITHUB_OUTPUT: path.join(root, 'outputs.txt'),
  });
  return { root, environment, head, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function preparedWorkspace() {
  const fixture = await workspace();
  const result = await prepareArtifact(fixture);
  return { ...fixture, manifest: result.manifest, selected: {
    producer: clone(result.manifest.producer), artifactId: 30,
    artifactName: result.artifactName, artifactDigest: digest,
  } };
}

test('the exact successful main push run and attempt select one immutable artifact ID', async () => {
  const fixture = apiFixture();
  // Other attempts are present and must never become an implicit fallback.
  fixture.data.artifacts.unshift({ ...clone(fixture.data.artifacts[0]), id: 29, name: 'ec-site-jar-20-1' });
  const result = await selectArtifact(fixture);
  assert.equal(result.artifactId, 30);
  assert.equal(result.artifactName, 'ec-site-jar-20-2');
  assert.equal(result.producer.headSha, sha);
  assert.equal(result.artifactDigest, digest);
  assert.equal(fixture.calls.find(call => call[0] === 'workflow')[1].workflow_id, 'ci.yml');
  assert.deepEqual(fixture.calls.find(call => call[0] === 'artifacts')[1], {
    owner: 'fixture-owner', repo: 'ec-site-java', run_id: 20, per_page: 100,
  });
});

test('PR, fork, failed, wrong-branch and malformed events fail before any API access', async () => {
  for (const change of [
    f => { f.context.eventName = 'workflow_dispatch'; },
    f => { f.context.payload.action = 'requested'; },
    f => { f.context.payload.repository.default_branch = 'develop'; },
    f => { f.context.payload.repository.full_name = 'different/repository'; },
    f => { f.context.payload.workflow_run.event = 'pull_request'; },
    f => { f.context.payload.workflow_run.conclusion = 'failure'; },
    f => { f.context.payload.workflow_run.status = 'in_progress'; },
    f => { f.context.payload.workflow_run.head_branch = 'develop'; },
    f => { f.context.payload.workflow_run.head_repository.id = 99; },
    f => { f.context.payload.workflow_run.head_repository.full_name = 'fork/repository'; },
    f => { f.context.payload.workflow_run.run_attempt = 0; },
    f => { f.context.payload.workflow_run.id = '20'; },
    f => { f.context.payload.workflow_run.head_sha = 'main'; },
  ]) {
    const fixture = apiFixture(); change(fixture);
    await assert.rejects(selectArtifact(fixture), /CI artifact:/u);
    assert.deepEqual(fixture.calls, []);
  }
});

test('fresh API facts must still match the workflow, repository, attempt and current main', async () => {
  for (const change of [
    f => { f.data.repo.id = 99; },
    f => { f.data.repo.default_branch = 'develop'; },
    f => { f.data.workflow.path = '.github/workflows/unrelated.yml'; },
    f => { f.data.workflow.name = 'Different CI'; },
    f => { f.data.workflow.state = 'disabled_manually'; },
    f => { f.data.run.workflow_id = 99; },
    f => { f.data.run.path = '.github/workflows/unrelated.yml'; },
    f => { f.data.run.id = 21; },
    f => { f.data.run.run_attempt = 3; },
    f => { f.data.run.event = 'pull_request'; },
    f => { f.data.run.status = 'in_progress'; },
    f => { f.data.run.conclusion = 'cancelled'; },
    f => { f.data.run.head_sha = 'c'.repeat(40); },
    f => { f.data.run.repository.id = 99; },
    f => { f.data.run.head_repository.id = 99; },
    f => { f.data.branch.commit.sha = 'c'.repeat(40); },
  ]) {
    const fixture = apiFixture(); change(fixture);
    await assert.rejects(selectArtifact(fixture), /CI artifact:/u);
    assert.equal(fixture.calls.some(call => call[0] === 'artifacts'), false);
  }
});

test('missing, old-attempt, ambiguous, expired and unbound artifacts never fall back', async () => {
  for (const change of [
    f => { f.data.artifacts = []; },
    f => { f.data.artifacts[0].name = 'ec-site-jar-20-1'; },
    f => { f.data.artifacts.push(clone(f.data.artifacts[0])); },
    f => { f.data.artifacts[0].expired = true; },
    f => { f.data.artifacts[0].size_in_bytes = 0; },
    f => { delete f.data.artifacts[0].digest; },
    f => { f.data.artifacts[0].digest = 'sha256:not-a-digest'; },
    f => { f.data.artifacts[0].id = 0; },
    f => { f.data.artifacts[0].workflow_run.id = 21; },
    f => { f.data.artifacts[0].workflow_run.repository_id = 99; },
    f => { f.data.artifacts[0].workflow_run.head_repository_id = 99; },
    f => { f.data.artifacts[0].workflow_run.head_branch = 'develop'; },
    f => { f.data.artifacts[0].workflow_run.head_sha = 'c'.repeat(40); },
  ]) {
    const fixture = apiFixture(); change(fixture);
    await assert.rejects(selectArtifact(fixture), /CI artifact:/u);
  }
});

test('a newer main commit or newer run attempt is rejected again before deployment', async () => {
  for (const change of [
    f => { f.data.branch.commit.sha = 'c'.repeat(40); },
    f => { f.data.run.run_attempt = 3; },
  ]) {
    const fixture = apiFixture();
    const selected = await selectArtifact(fixture);
    change(fixture);
    await assert.rejects(currentProducer(fixture), /CI artifact:/u);
    assert.equal(selected.producer.headSha, sha);
  }
});

test('the actual producer CLI binds a clean Git checkout and complete JAR bytes', async () => {
  const fixture = await workspace();
  try {
    const result = spawnSync(process.execPath, [helper, 'prepare'], {
      cwd: fixture.root, env: fixture.environment, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(fixture.environment.GITHUB_OUTPUT, 'utf8'), 'artifact-name=ec-site-jar-20-2\n');
    const manifest = JSON.parse(await readFile(path.join(fixture.root, artifactDirectory, 'provenance.json'), 'utf8'));
    const jar = await readFile(path.join(fixture.root, artifactDirectory, manifest.jar.name));
    assert.equal(manifest.producer.headSha, fixture.head);
    assert.equal(manifest.producer.runAttempt, 2);
    assert.equal(manifest.jar.bytes, jar.byteLength);
    assert.equal(manifest.jar.sha256, 'sha256:' + createHash('sha256').update(jar).digest('hex'));
  } finally { await fixture.cleanup(); }
});

test('producer rejects different source, dirty checkout, untrusted context, missing and multiple JARs', async () => {
  for (const change of [
    async f => { f.environment.GITHUB_SHA = sha; },
    async f => { await appendFile(path.join(f.root, 'README.md'), 'Changed source.\n'); },
    async f => { f.environment.GITHUB_EVENT_NAME = 'pull_request'; },
    async f => { f.environment.GITHUB_WORKFLOW_REF = 'fork/repo/.github/workflows/ci.yml@refs/heads/main'; },
    async f => { await rm(path.join(f.root, 'target/ec-site-0.0.1-SNAPSHOT.jar')); },
    async f => { await writeFile(path.join(f.root, 'target/ec-site-extra.jar'), 'unexpected'); },
    async f => { await rm(path.join(f.root, 'target/ec-site-0.0.1-SNAPSHOT.jar')); await symlink('../README.md', path.join(f.root, 'target/ec-site-0.0.1-SNAPSHOT.jar')); },
  ]) {
    const fixture = await workspace();
    try {
      await change(fixture);
      await assert.rejects(prepareArtifact(fixture), /CI artifact:/u);
      await assert.rejects(readFile(path.join(fixture.root, artifactDirectory, 'provenance.json')), { code: 'ENOENT' });
    } finally { await fixture.cleanup(); }
  }
});

test('both deployment filenames preserve the exact verified JAR bytes', async () => {
  for (const destinationName of [null, 'ec-site.jar']) {
    const fixture = await preparedWorkspace();
    try {
      await rm(path.join(fixture.root, 'target'), { recursive: true });
      const result = await stageArtifact({ root: fixture.root, selected: fixture.selected, destinationName });
      assert.equal(result.file, 'target/' + (destinationName ?? fixture.manifest.jar.name));
      assert.equal(result.sha256, fixture.manifest.jar.sha256);
      assert.deepEqual(await readFile(path.join(fixture.root, result.file)),
        await readFile(path.join(fixture.root, artifactDirectory, fixture.manifest.jar.name)));
    } finally { await fixture.cleanup(); }
  }
});

test('bundle rejects altered bytes, metadata, path traversal, extra entries and symlinks', async () => {
  for (const change of [
    async f => { await appendFile(path.join(f.root, artifactDirectory, f.manifest.jar.name), 'tamper'); },
    async f => { f.manifest.producer.headSha = sha; },
    async f => { f.manifest.producer.runAttempt = 1; },
    async f => { f.manifest.jar.name = '../ec-site-escape.jar'; },
    async f => { f.manifest.jar.sha256 = digest; },
    async f => { await writeFile(path.join(f.root, artifactDirectory, 'extra.txt'), 'unexpected'); },
    async f => { await mkdir(path.join(f.root, artifactDirectory, 'nested')); },
    async f => { const p = path.join(f.root, artifactDirectory, f.manifest.jar.name); await rm(p); await symlink('../README.md', p); },
  ]) {
    const fixture = await preparedWorkspace();
    try {
      await change(fixture);
      await writeFile(path.join(fixture.root, artifactDirectory, 'provenance.json'), JSON.stringify(fixture.manifest));
      await assert.rejects(verifyBundle({ directory: path.join(fixture.root, artifactDirectory), selected: fixture.selected }), /CI artifact:/u);
    } finally { await fixture.cleanup(); }
  }
});

test('staging cannot reuse an earlier build or a different checkout', async () => {
  const fixture = await preparedWorkspace();
  try {
    await assert.rejects(stageArtifact({ root: fixture.root, selected: fixture.selected }), { code: 'EEXIST' });
    await rm(path.join(fixture.root, 'target'), { recursive: true });
    await appendFile(path.join(fixture.root, 'README.md'), 'Changed source.\n');
    await assert.rejects(stageArtifact({ root: fixture.root, selected: fixture.selected }), /tracked checkout files changed/u);
    await assert.rejects(readFile(path.join(fixture.root, 'target', fixture.manifest.jar.name)), { code: 'ENOENT' });
  } finally { await fixture.cleanup(); }
});
