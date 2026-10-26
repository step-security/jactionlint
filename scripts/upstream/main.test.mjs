import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { classifyFiles, latestRelease, parseSubmodules, reviewLeads, runSources } from './main.mjs'

const manager = fileURLToPath(new URL('./main.mjs', import.meta.url))

function assertApplyCommand(output, source, tag, sha) {
  const command = `mise exec node@lts -- node ./scripts/upstream/main.mjs ${source} update --apply ${tag} ${sha} --accept-reviewed`
  assert.ok(output.includes(command), `expected output to include: ${command}`)
}

test('all-upstreams updates continue after failures and report them together', async () => {
  const visited = []
  await assert.rejects(runSources(['bad', 'good', 'also-bad'], 'update', undefined, async name => {
    visited.push(name)
    if (name !== 'good') throw new Error('candidate rejected')
  }), /bad: candidate rejected\nalso-bad: candidate rejected/)
  assert.deepEqual(visited, ['bad', 'good', 'also-bad'])
})

test('checks and explicitly selected updates stop on failure', async () => {
  const failure = new Error('candidate rejected')
  await assert.rejects(runSources(['one', 'two'], 'check', undefined, async () => { throw failure }), error => error === failure)
  await assert.rejects(runSources(['one'], 'update', 'one', async () => { throw failure }), error => error === failure)
})

test('parseSubmodules keeps full ref separate from its inline version label', () => {
  const entries = parseSubmodules(`# title\n[submodule "upstream/actionlint"]\n\tpath = upstream/actionlint\n\turl = https://github.com/rhysd/actionlint.git\n\tref = ${'a'.repeat(40)} # v1.7.12\n\tbranch = v1.7.12\n`)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].fields.ref, 'a'.repeat(40))
  assert.equal(entries[0].fields.branch, 'v1.7.12')
})

test('latestRelease ignores prereleases and compares semantic versions numerically', () => {
  const result = latestRelease([
    `${'1'.repeat(40)}\trefs/tags/v1.9.0`,
    `${'2'.repeat(40)}\trefs/tags/v1.10.0`,
    `${'3'.repeat(40)}\trefs/tags/v2.0.0-rc.1`,
  ].join('\n'))
  assert.equal(result.tag, 'v1.10.0')
  assert.equal(result.sha, '2'.repeat(40))
})

test('latestRelease resolves annotated tags to their peeled commit SHA', () => {
  const result = latestRelease([
    `${'a'.repeat(40)}\trefs/tags/v1.8.0`,
    `${'b'.repeat(40)}\trefs/tags/v1.8.0^{}`,
  ].join('\n'))
  assert.equal(result.sha, 'b'.repeat(40))
})

test('latestRelease resolves annotated tags without a v prefix', () => {
  const result = latestRelease([
    `${'a'.repeat(40)}\trefs/tags/4.0.2`,
    `${'b'.repeat(40)}\trefs/tags/4.0.2^{}`,
  ].join('\n'))
  assert.equal(result.tag, '4.0.2')
  assert.equal(result.sha, 'b'.repeat(40))
})

test('latestRelease keeps stable tags with equal semantic versions', () => {
  const result = latestRelease([
    `${'1'.repeat(40)}\trefs/tags/1.8.0`,
    `${'2'.repeat(40)}\trefs/tags/v1.8.0`,
  ].join('\n'))
  assert.equal(result.tag, 'v1.8.0')
})

test('latestRelease rejects an empty or non-semver tag set', () => {
  assert.throws(() => latestRelease(''), /no stable/)
  assert.throws(() => latestRelease(`${'a'.repeat(40)}\trefs/tags/latest`), /no stable/)
})

test('classifyFiles identifies detection code, tests, and fixtures for every reference', () => {
  assert.deepEqual(classifyFiles('pattern-review', ['testdata/err/example.yaml', 'rule_example.go', 'rule_example_test.go', 'opaque.bin'], 'actionlint'), [
    { file: 'testdata/err/example.yaml', classification: 'pattern-fixture-review' },
    { file: 'rule_example.go', classification: 'detection-source-review' },
    { file: 'rule_example_test.go', classification: 'detection-test-review' },
    { file: 'opaque.bin', classification: 'source-review-required' },
  ])
  assert.deepEqual(classifyFiles('pattern-review', ['src/CheckFoo.hs', 'test/fixtures/foo.json', 'ShellCheck.cabal'], 'shellcheck'), [
    { file: 'src/CheckFoo.hs', classification: 'detection-source-review' },
    { file: 'test/fixtures/foo.json', classification: 'detection-test-review' },
    { file: 'ShellCheck.cabal', classification: 'source-review-required' },
  ])
  assert.deepEqual(classifyFiles('pattern-review', ['pyflakes/checker.py', 'pyflakes/test/test_checker.py', 'setup.py'], 'pyflakes'), [
    { file: 'pyflakes/checker.py', classification: 'detection-source-review' },
    { file: 'pyflakes/test/test_checker.py', classification: 'detection-test-review' },
    { file: 'setup.py', classification: 'source-review-required' },
  ])
})

test('reviewLeads identifies Actionlint detection changes and links existing local rule names', () => {
  const leads = reviewLeads('actionlint', [
    { file: 'rule_new.go', classification: 'source-review-required' },
  ], {
    'rule_new.go': 'package actionlint\ntype RuleOld struct{}\n',
  }, {
    'rule_new.go': 'package actionlint\ntype RuleOld struct{}\ntype RuleNew struct{}\n',
  }, { RuleNew: 'RuleNew' })
  assert.deepEqual(leads, [{
    file: 'rule_new.go', kind: 'detection-review', added_symbols: ['RuleNew'], removed_symbols: [],
    local_matches: [{ upstream_symbol: 'RuleNew', local: 'RuleNew' }],
    local_review_files: [],
    review: 'inspect-symbol-diff-and-upstream-tests',
  }])
})

test('reviewLeads flags removed Actionlint rules for review without inventing a local match', () => {
  const leads = reviewLeads('actionlint', [
    { file: 'rule_old.go', classification: 'source-review-required' },
  ], { 'rule_old.go': 'package actionlint\ntype RuleOld struct{}\n' }, {
    'rule_old.go': 'package actionlint\n',
  }, {})
  assert.deepEqual(leads[0].removed_symbols, ['RuleOld'])
  assert.deepEqual(leads[0].local_matches, [])
  assert.equal(leads[0].review, 'inspect-symbol-diff-and-upstream-tests')
})

test('reviewLeads links a removed Actionlint rule to the matching local rule', () => {
  const leads = reviewLeads('actionlint', [
    { file: 'rule_old.go', classification: 'detection-source-review' },
  ], { 'rule_old.go': 'package actionlint\ntype RuleOld struct{}\n' }, {
    'rule_old.go': 'package actionlint\n',
  }, { RuleOld: 'RuleOld' })
  assert.deepEqual(leads[0].removed_symbols, ['RuleOld'])
  assert.deepEqual(leads[0].local_matches, [{ upstream_symbol: 'RuleOld', local: 'RuleOld' }])
})

test('reviewLeads identifies new Zizmor audits and unmatched audit IDs', () => {
  const leads = reviewLeads('zizmor', [
    { file: 'crates/zizmor/src/audit/new_audit.rs', classification: 'source-review-required' },
  ], {
    'crates/zizmor/src/audit/new_audit.rs': 'audit_meta!(NewAudit, "old-audit");\n',
  }, {
    'crates/zizmor/src/audit/new_audit.rs': 'audit_meta!(NewAudit, "new-audit");\n',
  }, { 'new-audit': ['new-audit'] })
  assert.equal(leads[0].added_symbols[0], 'new-audit')
  assert.deepEqual(leads[0].local_matches, [{ upstream_symbol: 'new-audit', local: ['new-audit'] }])
})

test('reviewLeads flags changed Zizmor audits with no existing mapping', () => {
  const leads = reviewLeads('zizmor', [
    { file: 'crates/zizmor/src/audit/known.rs', classification: 'source-review-required' },
  ], { 'crates/zizmor/src/audit/known.rs': 'audit_meta!(Known, "already-mapped");\n' }, {
    'crates/zizmor/src/audit/known.rs': 'audit_meta!(Known, "already-mapped");\n// logic changed\n',
  }, { 'already-mapped': ['local-rule'] })
  assert.deepEqual(leads[0].added_symbols, [])
  assert.equal(leads[0].review, 'inspect-source-diff-and-upstream-tests')
  assert.deepEqual(leads[0].local_matches, [{ upstream_symbol: 'already-mapped', local: ['local-rule'] }])
})

test('reviewLeads detects removed mapped Zizmor audits', () => {
  const leads = reviewLeads('zizmor', [
    { file: 'crates/zizmor/src/audit/removed.rs', classification: 'source-review-required' },
  ], { 'crates/zizmor/src/audit/removed.rs': 'audit_meta!(Removed, "removed-audit");\n' }, {
    'crates/zizmor/src/audit/removed.rs': '',
  }, { 'removed-audit': ['local-rule'] })
  assert.deepEqual(leads[0].removed_symbols, ['removed-audit'])
  assert.deepEqual(leads[0].local_matches, [{ upstream_symbol: 'removed-audit', local: ['local-rule'] }])
})

test('reviewLeads reports analyzer source/test review leads for changed files', () => {
  const shellcheck = reviewLeads('shellcheck', [
    { file: 'src/ShellCheck/Analytics.hs', classification: 'source-review-required' },
  ], { 'src/ShellCheck/Analytics.hs': 'module Analytics where\n' }, {
    'src/ShellCheck/Analytics.hs': 'module Analytics where\nsc9999 = checkSomething\n',
  })
  assert.deepEqual(shellcheck[0].added_symbols, ['SC9999'])
  assert.deepEqual(shellcheck[0].local_matches, [])
  const removed = reviewLeads('shellcheck', [
    { file: 'src/ShellCheck/Analytics.hs', classification: 'source-review-required' },
  ], { 'src/ShellCheck/Analytics.hs': 'sc9999 = checkSomething\n' }, {
    'src/ShellCheck/Analytics.hs': '',
  })
  assert.deepEqual(removed[0].removed_symbols, ['SC9999'])
  const checkSymbol = reviewLeads('shellcheck', [
    { file: 'src/ShellCheck/Analytics.hs', classification: 'source-review-required' },
  ], { 'src/ShellCheck/Analytics.hs': '' }, {
    'src/ShellCheck/Analytics.hs': 'newShellCheck = checkNew\n',
  })
  assert.deepEqual(checkSymbol[0].added_symbols, ['NEWSHELLCHECK'])
  assert.deepEqual(checkSymbol[0].local_matches, [])
  const pyflakes = reviewLeads('pyflakes', [
    { file: 'pyflakes/messages.py', classification: 'source-review-required' },
  ], { 'pyflakes/messages.py': 'class OldMessage: pass\n' }, {
    'pyflakes/messages.py': 'class OldMessage: pass\nclass NewIssue(Message):\n    message = "new issue"\n',
  })
  assert.deepEqual(pyflakes[0].added_symbols, ['NewIssue'])
  assert.deepEqual(pyflakes[0].local_matches, [])
  const removedPyflakes = reviewLeads('pyflakes', [
    { file: 'pyflakes/messages.py', classification: 'source-review-required' },
  ], { 'pyflakes/messages.py': 'class OldIssue(Message):\n' }, {
    'pyflakes/messages.py': '',
  })
  assert.deepEqual(removedPyflakes[0].removed_symbols, ['OldIssue'])
  const checkerChange = reviewLeads('pyflakes', [
    { file: 'pyflakes/checker.py', classification: 'source-review-required' },
  ], { 'pyflakes/checker.py': 'def old_check(): pass\n' }, {
    'pyflakes/checker.py': 'def new_check(): pass\n',
  })
  assert.equal(checkerChange[0].review, 'inspect-source-diff-and-upstream-tests')
})

test('reviewLeads ignores unrelated files with no recognized behavior markers', () => {
  assert.deepEqual(reviewLeads('actionlint', [
    { file: 'README.md', classification: 'source-review-required' },
  ], { 'README.md': 'Old text\n' }, { 'README.md': 'New text\n' }), [])
})

test('reviewLeads surfaces changed Actionlint test and fixture patterns for review', () => {
  const tests = reviewLeads('actionlint', [
    { file: 'rule_if_cond_test.go', classification: 'detection-test-review' },
    { file: 'testdata/err/new-pattern.yaml', classification: 'pattern-fixture-review' },
  ], {
    'rule_if_cond_test.go': 'package actionlint\nfunc TestOldPattern() {}\n',
    'testdata/err/new-pattern.yaml': 'on: push\n',
  }, {
    'rule_if_cond_test.go': 'package actionlint\nfunc TestNewPattern() {}\n',
    'testdata/err/new-pattern.yaml': 'on: pull_request\n',
  })
  assert.deepEqual(tests.map(lead => lead.file), ['rule_if_cond_test.go', 'testdata/err/new-pattern.yaml'])
  assert.ok(tests.every(lead => lead.kind === 'detection-review'))
  assert.ok(tests.every(lead => lead.review === 'inspect-source-diff-and-upstream-tests'))
})

test('setup pins the requested SHA after a tag moves, keeps the sparse cone, and check recovers interrupted apply offline', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jactionlint-manager-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const remote = path.join(temp, 'remote.git')
  const source = path.join(temp, 'source')
  const root = path.join(temp, 'project')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote])
  execFileSync('git', ['init', '--initial-branch=main', source])
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Test'])
  execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('git', ['-C', source, 'remote', 'add', 'origin', `file://${remote}`])
  const sourceFiles = {
    'actionlint.go': 'package actionlint\n',
    'rule_if_cond.go': 'package actionlint\ntype RuleIfCond struct{}\n',
    'rule_if_cond_test.go': 'package actionlint\nfunc TestOldConditionPattern() {}\n',
    'go.mod': 'module example.test/actionlint\n\ngo 1.22\n',
    'go.sum': '',
    'cmd/actionlint.go': 'package main\n',
    'testdata/err/sample.yaml': 'on: push\n',
    'testdata/examples/sample.yaml': 'on: push\n',
    'docs/unneeded.md': 'outside the sparse checkout\n',
  }
  for (const [file, contents] of Object.entries(sourceFiles)) {
    const target = path.join(source, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  execFileSync('git', ['-C', source, 'add', '.'])
  execFileSync('git', ['-C', source, 'commit', '-m', 'first source'])
  const pinnedSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', 'v1.0.0'])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])
  await writeFile(path.join(source, 'actionlint.go'), 'package actionlint\n// moved tag\n')
  execFileSync('git', ['-C', source, 'commit', '-am', 'move release tag'])
  const movedSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', '-f', 'v1.0.0'])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--force', 'refs/tags/v1.0.0'])

  await mkdir(path.join(root, '.config/repo'), { recursive: true })
  await mkdir(path.join(root, 'scripts/upstream'), { recursive: true })
  execFileSync('git', ['init', root])
  const checksum = '0'.repeat(64)
  const otherReleasePin = `# another-v1.0.0 sha256:${checksum}\n[submodule "upstream/another"]\n\tpath = upstream/another\n\turl = https://example.invalid/another.git\n\tref = ${'b'.repeat(40)} # v1.0.0\n\tbranch = v1.0.0\n\tshallow = true\n\tsparse-checkout = /src/**\n`
  const gitmodules = `# actionlint-v1.0.0 sha256:${checksum}\n[submodule "upstream/actionlint"]\n\tpath = upstream/actionlint\n\turl = file://${remote}\n\tignore = dirty\n\tref = ${pinnedSha} # v1.0.0\n\tbranch = v1.0.0\n\tshallow = true\n\tsparse-checkout = /*.go /go.mod /go.sum /cmd/** /testdata/err/** /testdata/examples/**\n${otherReleasePin}`
  const manifest = `${JSON.stringify({ upstreams: { actionlint: { submodule: 'upstream/actionlint', repo: `file://${remote}` } }, rows: [{ kind: 'version-pin', id: 'actionlint', upstream: 'actionlint', pinned_tag: 'v1.0.0' }] }, null, 2)}\n`
  await writeFile(path.join(root, '.gitmodules'), gitmodules)
  await writeFile(path.join(root, '.config/repo/lockstep.json'), manifest)
  const mise = '[tools]\n'
  await writeFile(path.join(root, 'mise.toml'), mise)
  await mkdir(path.join(root, 'upstream/actionlint'), { recursive: true })
  const env = {
    ...process.env,
    JACTIONLINT_UPSTREAM_TEST_ROOT: root,
    JACTIONLINT_UPSTREAM_TEST_URL: `file://${remote}`,
    GIT_TERMINAL_PROMPT: '0',
  }
  const run = (...args) => spawnSync(process.execPath, [manager, ...args], { cwd: root, env, encoding: 'utf8' })
  const runAsync = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [manager, ...args], { cwd: root, env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })

  const pinCases = [
    [gitmodules.replace(`ref = ${pinnedSha} # v1.0.0`, 'ref = short # v1.0.0'), /ref must be a full commit SHA/],
    [gitmodules.replace('branch = v1.0.0', 'branch = v1.0.1'), /branch must match its release-tag ref comment/],
    [gitmodules.replace('shallow = true', 'shallow = false'), /must set shallow = true/],
    [gitmodules.replace('/cmd/**', '/cmd/*'), /sparse-checkout must match/],
    [gitmodules.replace('# actionlint-v1.0.0 sha256:', '# actionlint-v1.0.1 sha256:'), /needs a matching archive sha256 comment/],
  ]
  for (const [invalidPin, expectedError] of pinCases) {
    await writeFile(path.join(root, '.gitmodules'), invalidPin)
    await writeFile(path.join(root, '.config/repo/lockstep.json'), manifest)
    const selectedPin = run('check')
    assert.notEqual(selectedPin.status, 0)
    assert.match(selectedPin.stderr, expectedError)
  }
  await writeFile(path.join(root, '.gitmodules'), gitmodules)
  await writeFile(path.join(root, '.config/repo/lockstep.json'), manifest.replace('"pinned_tag": "v1.0.0"', '"pinned_tag": "v1.0.1"'))
  const mismatchedManifest = run('check')
  assert.notEqual(mismatchedManifest.status, 0)
  assert.match(mismatchedManifest.stderr, /lockstep row must match/)
  await writeFile(path.join(root, '.gitmodules'), gitmodules)
  await writeFile(path.join(root, '.config/repo/lockstep.json'), manifest)

  const pinOnlyCheck = run('check')
  assert.equal(pinOnlyCheck.status, 0, pinOnlyCheck.stderr)
  assert.match(pinOnlyCheck.stdout, /pin valid; sparse reference not materialized/)
  assert.deepEqual(await readdir(path.join(root, 'upstream')), ['actionlint'], 'checking pins does not initialize other upstreams')

  const setup = run('setup')
  assert.equal(setup.status, 0, setup.stderr)
  assert.match(run('invalid-command').stderr, /usage: node scripts\/upstream\/main\.mjs/)
  assert.deepEqual((await readdir(path.join(root, 'upstream'))).sort(), ['actionlint'], 'source-specific setup leaves other upstream references unmaterialized')
  const checkout = path.join(root, 'upstream/actionlint')
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pinnedSha)
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'HEAD')
  assert.notEqual(pinnedSha, movedSha)
  assert.equal(
    (await readFile(path.join(checkout, 'actionlint.go'), 'utf8')).replace(/\r\n/g, '\n'),
    sourceFiles['actionlint.go'],
  )
  await assert.rejects(readFile(path.join(checkout, 'docs/unneeded.md')))

  const offlineRemote = `${remote}.offline`
  await rename(remote, offlineRemote)
  const offlineSetup = run('setup')
  await rename(offlineRemote, remote)
  assert.equal(offlineSetup.status, 0, offlineSetup.stderr)

  const managerLock = path.join(root, '.git/jactionlint-upstream.lock')
  await mkdir(managerLock)
  await writeFile(path.join(managerLock, 'owner.json'), JSON.stringify({ pid: process.pid }))
  const lockedCheck = run('check')
  assert.notEqual(lockedCheck.status, 0)
  assert.match(lockedCheck.stderr, /another upstream manager command owns the lock/)
  await rm(managerLock, { recursive: true })
  await mkdir(managerLock)
  const malformedLock = run('check')
  assert.notEqual(malformedLock.status, 0)
  assert.match(malformedLock.stderr, /lock needs manual cleanup/)
  await rm(managerLock, { recursive: true })

  const transactionPath = path.join(root, '.git/jactionlint-upstream-apply.json')
  await writeFile(transactionPath, '{}')
  const invalidRecovery = run('check')
  assert.match(invalidRecovery.stderr, /recovery record .* is invalid/)
  await writeFile(transactionPath, '{')
  const unreadableRecovery = run('check')
  assert.match(unreadableRecovery.stderr, /cannot read upstream apply recovery record/)
  await rm(transactionPath)

  await writeFile(path.join(checkout, 'actionlint.go'), 'package actionlint\ninterrupted update\n')
  execFileSync('git', ['-C', checkout, 'fetch', '--depth', '1', 'origin', movedSha])
  execFileSync('git', ['-C', checkout, 'checkout', '--force', '--detach', movedSha])
  const changedGitmodules = gitmodules.replace('v1.0.0', 'v1.0.1').replace(pinnedSha, movedSha)
  const changedManifest = manifest.replace('v1.0.0', 'v1.0.1')
  await writeFile(path.join(root, '.gitmodules'), changedGitmodules)
  await writeFile(path.join(root, '.config/repo/lockstep.json'), changedManifest)
  await writeFile(transactionPath, JSON.stringify({
    files: {
      '.gitmodules': { before: gitmodules, after: changedGitmodules },
      '.config/repo/lockstep.json': { before: manifest, after: changedManifest },
      'mise.toml': { before: mise, after: mise },
    },
    upstream: 'actionlint', old_sha: pinnedSha, new_sha: movedSha, old_tag: 'v1.0.0',
  }))

  await writeFile(path.join(checkout, 'actionlint.go'), 'preserve local edits\n')
  const refusedRecovery = run('check')
  assert.notEqual(refusedRecovery.status, 0)
  assert.match(refusedRecovery.stderr, /has local changes; refusing recovery/)
  assert.equal(await readFile(path.join(checkout, 'actionlint.go'), 'utf8'), 'preserve local edits\n')
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), changedGitmodules)
  await rm(path.join(checkout, 'actionlint.go'))
  execFileSync('git', ['-C', checkout, 'checkout', '--', 'actionlint.go'])

  const concurrentEdit = `${changedGitmodules}# keep this maintainer edit\n`
  await writeFile(path.join(root, '.gitmodules'), concurrentEdit)
  const preserveEdit = run('check')
  assert.notEqual(preserveEdit.status, 0)
  assert.match(preserveEdit.stderr, /tracked metadata changed since interrupted apply/)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), concurrentEdit)
  await writeFile(path.join(root, '.gitmodules'), changedGitmodules)

  const recovered = run('check')
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), gitmodules)
  assert.equal(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8'), manifest)
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pinnedSha)
  await assert.rejects(readFile(transactionPath))

  await writeFile(transactionPath, JSON.stringify({
    files: {
      '.gitmodules': { before: gitmodules, after: gitmodules },
      '.config/repo/lockstep.json': { before: manifest, after: manifest },
      'mise.toml': { before: mise, after: mise },
    },
    upstream: 'actionlint', old_sha: pinnedSha, new_sha: movedSha, old_tag: 'v1.0.0',
  }))
  const absentCheckout = `${checkout}.absent`
  await rename(checkout, absentCheckout)
  const restoredCheckout = run('check')
  assert.equal(restoredCheckout.status, 0, restoredCheckout.stderr)
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pinnedSha)
  await rm(absentCheckout, { recursive: true, force: true })

  await writeFile(path.join(source, 'actionlint.go'), 'package actionlint\n// reviewed release\n')
  await writeFile(path.join(source, 'rule_new.go'), 'package actionlint\ntype RuleNew struct{}\n')
  await writeFile(path.join(source, 'rule_if_cond.go'), 'package actionlint\ntype RuleIfCond struct{}\n// changed detection pattern\n')
  await writeFile(path.join(source, 'rule_if_cond_test.go'), 'package actionlint\nfunc TestNewConditionPattern() {}\n')
  await writeFile(path.join(source, 'testdata/err/sample.yaml'), 'on: pull_request\n')
  execFileSync('git', ['-C', source, 'add', 'rule_new.go', 'rule_if_cond.go', 'rule_if_cond_test.go', 'testdata/err/sample.yaml'])
  execFileSync('git', ['-C', source, 'commit', '-am', 'reviewed release'])
  const candidateSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', 'v1.0.1'])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])
  const archiveBytes = Buffer.from('test archive')
  let moveTagDuringArchive = false
  let mutateMetadataDuringArchive = false
  const server = createServer((request, response) => {
    if (request.url !== `/archive/${candidateSha}`) { response.writeHead(404).end(); return }
    if (moveTagDuringArchive) {
      execFileSync('git', ['-C', source, 'tag', '-f', 'v1.0.1', 'v1.0.0'])
      execFileSync('git', ['-C', source, 'push', 'origin', '--force', 'refs/tags/v1.0.1'])
      moveTagDuringArchive = false
    }
    if (mutateMetadataDuringArchive) {
      execFileSync(process.execPath, ['-e', `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, '.gitmodules'))}, '# changed during archive download\\n')`])
      mutateMetadataDuringArchive = false
    }
    response.writeHead(200).end(archiveBytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  env.JACTIONLINT_UPSTREAM_TEST_ARCHIVE = `http://127.0.0.1:${address.port}/archive`

  const testInputs = {
    'mise.toml': mise,
    'scripts/upstream/main.mjs': await readFile(manager, 'utf8'),
    'scripts/upstream/feature-review.mjs': await readFile(new URL('./feature-review.mjs', import.meta.url), 'utf8'),
    'rule_if_cond.go': 'package jactionlint\ntype RuleIfCond struct{}\n',
    'rule_new.go': 'package jactionlint\ntype RuleOld struct{}\n',
  }
  for (const [file, contents] of Object.entries(testInputs)) {
    const target = path.join(root, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  await writeFile(path.join(root, '.config/repo/lockstep.json'), manifest)
  const malformedGitmodules = gitmodules.replace('\tbranch = v1.0.0', '\tbranch=v1.0.0')
  await writeFile(path.join(root, '.gitmodules'), malformedGitmodules)
  const metadataReject = await runAsync('update', '--apply', 'v1.0.1', candidateSha, '--accept-reviewed')
  assert.notEqual(metadataReject.status, 0)
  assert.match(metadataReject.stderr, /could not update each expected \.gitmodules entry exactly once/)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), malformedGitmodules)
  assert.equal(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8'), manifest)
  await writeFile(path.join(root, '.gitmodules'), gitmodules)

  mutateMetadataDuringArchive = true
  const metadataChangedDuringDownload = await runAsync('update', '--apply', 'v1.0.1', candidateSha, '--accept-reviewed')
  assert.notEqual(metadataChangedDuringDownload.status, 0)
  assert.match(metadataChangedDuringDownload.stderr, /verification inputs changed while downloading/)
  assert.match(await readFile(path.join(root, '.gitmodules'), 'utf8'), /changed during archive download/)
  await writeFile(path.join(root, '.gitmodules'), gitmodules)

  moveTagDuringArchive = true
  const movedTag = await runAsync('update', '--apply', 'v1.0.1', candidateSha, '--accept-reviewed')
  assert.notEqual(movedTag.status, 0)
  assert.match(movedTag.stderr, /release v1\.0\.1 moved during verification/)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), gitmodules)
  execFileSync('git', ['-C', source, 'tag', '-f', 'v1.0.1', candidateSha])
  execFileSync('git', ['-C', source, 'push', 'origin', '--force', 'refs/tags/v1.0.1'])

  const fakeGit = path.join(temp, 'fail-checkout.mjs')
  const failedOnce = path.join(temp, 'failed-checkout')
  await writeFile(fakeGit, `
    import { existsSync, writeFileSync } from 'node:fs'
    import { spawnSync } from 'node:child_process'
    const args = process.argv.slice(2)
    const matches = args.includes(process.env.JACTIONLINT_UPSTREAM_TEST_CHECKOUT_DIR) && args.includes('checkout') && args.includes('--detach') && args.includes(process.env.JACTIONLINT_UPSTREAM_TEST_FAIL_SHA)
    if (matches && !existsSync(process.env.JACTIONLINT_UPSTREAM_TEST_FAIL_MARKER)) {
      writeFileSync(process.env.JACTIONLINT_UPSTREAM_TEST_FAIL_MARKER, 'failed once')
      process.exit(1)
    }
    const result = spawnSync('git', args, { stdio: 'inherit' })
    process.exit(result.status ?? 1)
  `)
  env.JACTIONLINT_UPSTREAM_TEST_GIT = JSON.stringify([process.execPath, fakeGit])
  env.JACTIONLINT_UPSTREAM_TEST_CHECKOUT_DIR = checkout
  env.JACTIONLINT_UPSTREAM_TEST_FAIL_SHA = candidateSha
  env.JACTIONLINT_UPSTREAM_TEST_FAIL_MARKER = failedOnce
  const rolledBackApply = await runAsync('update', '--apply', 'v1.0.1', candidateSha, '--accept-reviewed')
  assert.notEqual(rolledBackApply.status, 0)
  assert.match(rolledBackApply.stderr, /Command failed/)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), gitmodules)
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pinnedSha)
  await assert.rejects(readFile(path.join(root, '.git/jactionlint-upstream-apply.json')))
  delete env.JACTIONLINT_UPSTREAM_TEST_GIT
  delete env.JACTIONLINT_UPSTREAM_TEST_CHECKOUT_DIR
  delete env.JACTIONLINT_UPSTREAM_TEST_FAIL_SHA
  delete env.JACTIONLINT_UPSTREAM_TEST_FAIL_MARKER

  const automaticApply = await runAsync('update', '--apply-latest')
  assert.equal(automaticApply.status, 0, automaticApply.stderr)
  assert.match(automaticApply.stderr, /requires source review; pin unchanged/)
  assertApplyCommand(automaticApply.stderr, 'actionlint', 'v1.0.1', candidateSha)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), gitmodules)

  await rm(checkout, { recursive: true, force: true })
  const applied = await runAsync('update', '--apply', 'v1.0.1', candidateSha, '--accept-reviewed')
  assert.equal(applied.status, 0, applied.stderr)
  assert.deepEqual((await readdir(path.join(root, 'upstream'))).sort(), ['actionlint'], 'applying a pin initializes only the selected upstream')
  const receipt = JSON.parse(applied.stdout).verification
  assert.equal(receipt.checks[0].status, 'review-required')
  assert.deepEqual(receipt.feature_review_leads.find(lead => lead.file === 'rule_new.go').added_symbols, ['RuleNew'])
  assert.deepEqual(receipt.detection_audit.changed_detection_sources.sort(), ['actionlint.go', 'rule_if_cond.go', 'rule_new.go'].sort())
  assert.deepEqual(receipt.detection_audit.changed_detection_tests, ['rule_if_cond_test.go'])
  assert.deepEqual(receipt.detection_audit.changed_pattern_fixtures, ['testdata/err/sample.yaml'])
  assert.ok(receipt.detection_audit.likely_local_rules.includes('RuleIfCond (rule_if_cond.go)'))
  assert.ok(receipt.detection_audit.unmatched_detection_symbols.includes('RuleNew'))
  assert.ok(!receipt.detection_audit.unmatched_detection_symbols.includes('RuleIfCond'))
  assert.match(receipt.verification_scope, /actionlint detection source, tests, patterns, and fixtures/)
  assert.match(await readFile(path.join(root, '.gitmodules'), 'utf8'), new RegExp(`ref = ${candidateSha} # v1\\.0\\.1`))
  assert.match(await readFile(path.join(root, '.gitmodules'), 'utf8'), /branch = v1\.0\.1/)
  const archiveSha = createHash('sha256').update(archiveBytes).digest('hex')
  assert.match(await readFile(path.join(root, '.gitmodules'), 'utf8'), new RegExp(`sha256:${archiveSha}`))
  assert.equal(JSON.parse(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8')).rows[0].pinned_tag, 'v1.0.1')
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), candidateSha)

  const acceptedGitmodules = await readFile(path.join(root, '.gitmodules'), 'utf8')
  assert.ok(acceptedGitmodules.endsWith(otherReleasePin), 'updating actionlint must preserve another project with the same release tag')
  const currentReport = await runAsync('update')
  assert.equal(currentReport.status, 0, currentReport.stderr)
  const currentReceipt = JSON.parse(currentReport.stdout).verification
  assert.equal(currentReceipt.passed, true)
  assert.deepEqual(currentReceipt.changed_files, [])
  assert.equal(currentReceipt.checks[0].status, 'passed')
  assert.ok(!currentReceipt.checks.some(check => check.command.startsWith('go test')))
  const currentAutoUpdate = await runAsync('update', '--apply-latest')
  assert.equal(currentAutoUpdate.status, 0, currentAutoUpdate.stderr)
  assert.equal(JSON.parse(currentAutoUpdate.stdout).verification.passed, true)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), acceptedGitmodules)

  await rm(remote, { recursive: true, force: true })
  const offlineCheck = run('check')
  assert.equal(offlineCheck.status, 0, offlineCheck.stderr)
  await writeFile(path.join(checkout, 'actionlint.go'), 'dirty\n')
  const dirtyCheck = run('check')
  assert.notEqual(dirtyCheck.status, 0)
  assert.match(dirtyCheck.stderr, /does not match its accepted SHA/)
})

test('zizmor setup and check enforce the pinned sparse shallow detached checkout without gitlinks', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jactionlint-zizmor-manager-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const remote = path.join(temp, 'remote.git')
  const source = path.join(temp, 'source')
  const root = path.join(temp, 'project')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote])
  execFileSync('git', ['init', '--initial-branch=main', source])
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Test'])
  execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('git', ['-C', source, 'remote', 'add', 'origin', `file://${remote}`])
  const auditFile = path.join(source, 'crates/zizmor/src/audit/example.rs')
  await mkdir(path.dirname(auditFile), { recursive: true })
  await writeFile(auditFile, '// initial source revision\naudit_meta!(OldAudit, "old-audit");\n')
  execFileSync('git', ['-C', source, 'add', '.'])
  execFileSync('git', ['-C', source, 'commit', '-m', 'first audit'])
  await writeFile(auditFile, '// current source revision\naudit_meta!(OldAudit, "old-audit");\n')
  execFileSync('git', ['-C', source, 'commit', '-am', 'current audit'])
  const pinnedSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', 'v1.0.0'])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])

  await mkdir(path.join(root, '.config/repo'), { recursive: true })
  await mkdir(path.join(root, 'scripts/zizmor-diff'), { recursive: true })
  await mkdir(path.join(root, 'scripts/upstream'), { recursive: true })
  execFileSync('git', ['init', root])
  const url = `file://${remote}`
  const gitmodules = `# zizmor-v1.0.0 sha256:${'0'.repeat(64)}\n[submodule "upstream/zizmor"]\n\tpath = upstream/zizmor\n\turl = ${url}\n\tref = ${pinnedSha} # v1.0.0\n\tbranch = v1.0.0\n\tshallow = true\n\tsparse-checkout = /crates/zizmor/src/audit/**\n`
  const manifest = JSON.stringify({
    upstreams: { zizmor: { submodule: 'upstream/zizmor', repo: url } },
    rows: [{ kind: 'version-pin', id: 'zizmor', upstream: 'zizmor', pinned_tag: 'v1.0.0' }],
  }, null, 2) + '\n'
  await writeFile(path.join(root, '.gitmodules'), gitmodules)
  await writeFile(path.join(root, '.config/repo/lockstep.json'), manifest)
  await writeFile(path.join(root, 'mise.toml'), '[tools]\nzizmor = "1.0.0"\n')
  await writeFile(path.join(root, 'scripts/zizmor-diff/mapping.json'), '{"zizmor":"1.0.0","audits":{"old-audit":{"jactionlint":[{"rule":"existing-rule"}]}}}\n')
  await writeFile(path.join(root, 'scripts/upstream/main.mjs'), await readFile(manager, 'utf8'))
  await writeFile(path.join(root, 'scripts/upstream/feature-review.mjs'), await readFile(new URL('./feature-review.mjs', import.meta.url), 'utf8'))
  const env = {
    ...process.env,
    JACTIONLINT_UPSTREAM_TEST_ROOT: root,
    JACTIONLINT_UPSTREAM_TEST_REPO: 'zizmor',
    JACTIONLINT_UPSTREAM_TEST_URL: url,
  }
  const run = (...args) => spawnSync(process.execPath, [manager, 'zizmor', ...args], { cwd: root, env, encoding: 'utf8' })
  const runAsync = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [manager, 'zizmor', ...args], { cwd: root, env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
  const setup = run('setup')
  assert.equal(setup.status, 0, setup.stderr)
  const checkout = path.join(root, 'upstream/zizmor')
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pinnedSha)
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim(), 'true')
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'HEAD')
  assert.equal((await readFile(path.join(checkout, 'crates/zizmor/src/audit/example.rs'), 'utf8')).replace(/\r\n/g, '\n'), '// current source revision\naudit_meta!(OldAudit, "old-audit");\n')
  await assert.rejects(readFile(path.join(checkout, 'crates/zizmor/src/audit/other.rs'), 'utf8'))
  const initialCheck = run('check')
  assert.equal(initialCheck.status, 0, initialCheck.stderr)

  execFileSync('git', ['-C', checkout, 'switch', '-c', 'attached-test'])
  assert.match(run('check').stderr, /detached sparse checkout contract/)
  execFileSync('git', ['-C', checkout, 'switch', '--detach', pinnedSha])

  execFileSync('git', ['-C', checkout, 'remote', 'set-url', 'origin', 'https://example.invalid/wrong.git'])
  assert.match(run('check').stderr, /detached sparse checkout contract/)
  execFileSync('git', ['-C', checkout, 'remote', 'set-url', 'origin', url])

  execFileSync('git', ['-C', checkout, 'config', 'core.sparseCheckout', 'false'])
  assert.match(run('check').stderr, /detached sparse checkout contract/)
  execFileSync('git', ['-C', checkout, 'config', 'core.sparseCheckout', 'true'])

  execFileSync('git', ['-C', checkout, 'config', 'core.sparseCheckoutCone', 'true'])
  assert.match(run('check').stderr, /detached sparse checkout contract/)
  execFileSync('git', ['-C', checkout, 'config', 'core.sparseCheckoutCone', 'false'])

  execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', `160000,${pinnedSha},upstream/other`])
  assert.match(run('check').stderr, /gitlinks/)
  execFileSync('git', ['-C', root, 'update-index', '--force-remove', 'upstream/other'])

  await writeFile(auditFile, '// current source revision\naudit_meta!(OldAudit, "old-audit");\naudit_meta!(NewAudit, "new-audit");\n')
  execFileSync('git', ['-C', source, 'add', auditFile])
  execFileSync('git', ['-C', source, 'commit', '-m', 'add an audit'])
  const candidateSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', 'v1.0.1'])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])
  const archiveBytes = Buffer.from('immutable zizmor candidate archive')
  const server = createServer((request, response) => {
    if (request.url !== `/archive/${candidateSha}`) { response.writeHead(404).end(); return }
    response.writeHead(200).end(archiveBytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  env.JACTIONLINT_UPSTREAM_TEST_ARCHIVE = `http://127.0.0.1:${server.address().port}/archive`
  const update = await runAsync('update')
  assert.equal(update.status, 0, update.stderr)
  const report = JSON.parse(update.stdout).verification
  assert.deepEqual(report.audit_inventory.new_audits, ['new-audit'])
  assert.deepEqual(report.audit_inventory.new_unmapped_audits, ['new-audit'])
  assert.deepEqual(report.audit_inventory.existing_unmapped_audits, [])
  assert.deepEqual(report.audit_inventory.mapped_audits, ['old-audit'])
  assert.deepEqual(report.feature_review_leads.find(lead => lead.file.endsWith('example.rs')).added_symbols, ['new-audit'])
  assert.equal(report.review_required, true)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), gitmodules)
  const automaticApply = await runAsync('update', '--apply-latest')
  assert.equal(automaticApply.status, 0, automaticApply.stderr)
  assert.match(automaticApply.stderr, /requires source review; pin unchanged/)
  assertApplyCommand(automaticApply.stderr, 'zizmor', 'v1.0.1', candidateSha)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), gitmodules)

  await writeFile(auditFile, '// extraction shape changed\n')
  execFileSync('git', ['-C', source, 'add', auditFile])
  execFileSync('git', ['-C', source, 'commit', '-m', 'change audit metadata shape'])
  const emptyInventorySha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', 'v1.0.2'])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])
  const emptyInventoryServer = createServer((request, response) => {
    if (request.url !== `/archive/${emptyInventorySha}`) { response.writeHead(404).end(); return }
    response.writeHead(200).end(archiveBytes)
  })
  await new Promise(resolve => emptyInventoryServer.listen(0, '127.0.0.1', resolve))
  t.after(() => emptyInventoryServer.close())
  env.JACTIONLINT_UPSTREAM_TEST_ARCHIVE = `http://127.0.0.1:${emptyInventoryServer.address().port}/archive`
  const emptyInventory = await runAsync('update')
  assert.notEqual(emptyInventory.status, 0)
  assert.match(emptyInventory.stderr, /audit extraction found 0 audits/)

  execFileSync('git', ['-C', source, 'tag', '-f', 'v1.0.2', candidateSha])
  execFileSync('git', ['-C', source, 'push', 'origin', '--force', 'refs/tags/v1.0.2'])
  env.JACTIONLINT_UPSTREAM_TEST_ARCHIVE = `http://127.0.0.1:${server.address().port}/archive`
  const apply = await runAsync('update', '--apply', 'v1.0.2', candidateSha, '--accept-reviewed')
  assert.equal(apply.status, 0, apply.stderr)
  assert.equal(JSON.parse(await readFile(path.join(root, 'scripts/zizmor-diff/mapping.json'), 'utf8')).zizmor, '1.0.2')
  assert.match(await readFile(path.join(root, '.gitmodules'), 'utf8'), new RegExp(`ref = ${candidateSha} # v1\\.0\\.2`))
  assert.equal(run('check').status, 0)

  execFileSync('git', ['-C', checkout, 'fetch', '--unshallow', 'origin'])
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim(), 'false')
  assert.match(run('check').stderr, /shallow detached sparse checkout contract/)
})

test('check rejects metadata that points at a different declared project', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jactionlint-production-pin-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const remote = path.join(temp, 'remote.git')
  const source = path.join(temp, 'source')
  const root = path.join(temp, 'project')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote])
  execFileSync('git', ['init', '--initial-branch=main', source])
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Test'])
  execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid'])
  await writeFile(path.join(source, 'actionlint.go'), 'package actionlint\n')
  execFileSync('git', ['-C', source, 'add', '.'])
  execFileSync('git', ['-C', source, 'commit', '-m', 'source'])
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', 'v1.0.0'])
  execFileSync('git', ['-C', source, 'remote', 'add', 'origin', `file://${remote}`])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])

  const url = 'https://github.com/rhysd/actionlint.git'
  await mkdir(path.join(root, '.config/repo'), { recursive: true })
  execFileSync('git', ['init', root])
  const gitmodules = `# actionlint-v1.0.0 sha256:${'0'.repeat(64)}\n[submodule "upstream/actionlint"]\n\tpath = upstream/actionlint\n\turl = ${url}\n\tref = ${sha} # v1.0.0\n\tbranch = v1.0.0\n\tshallow = true\n\tsparse-checkout = /*.go /go.mod /go.sum /cmd/** /testdata/err/** /testdata/examples/**\n`
  const manifest = `${JSON.stringify({
    upstreams: { actionlint: { submodule: 'upstream/actionlint', repo: url.replace(/\.git$/, '') } },
    rows: [{ kind: 'version-pin', id: 'actionlint', upstream: 'actionlint', pinned_tag: 'v1.0.0' }],
  }, null, 2)}\n`
  await writeFile(path.join(root, '.gitmodules'), gitmodules)
  await writeFile(path.join(root, '.config/repo/lockstep.json'), manifest)

  const checkout = path.join(root, 'upstream/actionlint')
  await mkdir(path.dirname(checkout), { recursive: true })
  execFileSync('git', ['clone', '--depth', '1', '--no-checkout', `file://${remote}`, checkout])
  execFileSync('git', ['-C', checkout, 'remote', 'set-url', 'origin', url])
  execFileSync('git', ['-C', checkout, 'config', 'core.sparseCheckout', 'true'])
  execFileSync('git', ['-C', checkout, 'config', 'core.sparseCheckoutCone', 'false'])
  await writeFile(path.join(checkout, '.git/info/sparse-checkout'), '/*.go\n/go.mod\n/go.sum\n/cmd/**\n/testdata/err/**\n/testdata/examples/**\n')
  execFileSync('git', ['-C', checkout, 'checkout', '--force', '--detach', sha])
  execFileSync('git', ['-C', checkout, 'read-tree', '-mu', 'HEAD'])

  const env = { ...process.env, JACTIONLINT_UPSTREAM_TEST_ROOT: root }
  delete env.JACTIONLINT_UPSTREAM_TEST_REPO
  delete env.JACTIONLINT_UPSTREAM_TEST_URL
  const run = () => spawnSync(process.execPath, [manager, 'actionlint', 'check'], { cwd: root, env, encoding: 'utf8' })
  const accepted = run()
  assert.equal(accepted.status, 0, accepted.stderr)

  const wrongUrl = 'https://example.invalid/actionlint'
  await writeFile(path.join(root, '.gitmodules'), gitmodules.replace(url, wrongUrl))
  await writeFile(path.join(root, '.config/repo/lockstep.json'), manifest.replace(url.replace(/\.git$/, ''), wrongUrl))
  const rejected = run()
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /URL differs from the declared upstream/)
})

test('ShellCheck and Pyflakes updates link local adapters and apply their mise pins', async t => {
  const definitions = [
    {
      name: 'shellcheck', url: 'https://github.com/koalaman/shellcheck.git',
      sparse: '/src/** /test/** /ShellCheck.cabal /LICENSE', tool: 'shellcheck',
      file: 'src/ShellCheck/Analytics.hs', before: 'module Analytics where\n',
      after: 'module Analytics where\nnewFooCheck = SC1234\n',
      projectInputs: ['rule_shellcheck.go', 'rule_shellcheck_test.go'],
      adapter: ['rule_shellcheck.go', 'rule_shellcheck_test.go'],
    },
    {
      name: 'pyflakes', url: 'https://github.com/PyCQA/pyflakes.git',
      sparse: '/pyflakes/** /setup.py /setup.cfg /LICENSE', tool: '"pipx:pyflakes"',
      file: 'pyflakes/messages.py', before: 'class OldIssue(Message):\n    pass\n',
      after: 'class OldIssue(Message):\n    pass\n\nclass NewIssue(Message):\n    pass\n',
      projectInputs: ['rule_pyflakes.go', 'rule_pyflakes_test.go'],
      adapter: ['rule_pyflakes.go', 'rule_pyflakes_test.go'],
    },
  ]

  for (const definition of definitions) {
    const temp = await mkdtemp(path.join(os.tmpdir(), `jactionlint-${definition.name}-manager-test-`))
    t.after(() => rm(temp, { recursive: true, force: true }))
    const remote = path.join(temp, 'remote.git')
    const source = path.join(temp, 'source')
    const root = path.join(temp, 'project')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote])
    execFileSync('git', ['init', '--initial-branch=main', source])
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Test'])
    execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid'])
    execFileSync('git', ['-C', source, 'remote', 'add', 'origin', `file://${remote}`])
    for (const [file, contents] of [[definition.file, definition.before], ['LICENSE', 'test license\n']]) {
      const target = path.join(source, file)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, contents)
    }
    execFileSync('git', ['-C', source, 'add', '.'])
    execFileSync('git', ['-C', source, 'commit', '-m', 'initial source'])
    const acceptedSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['-C', source, 'tag', 'v1.0.0'])
    execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])
    await writeFile(path.join(source, definition.file), definition.after)
    execFileSync('git', ['-C', source, 'commit', '-am', 'add analyzer behavior'])
    const candidateSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['-C', source, 'tag', 'v1.0.1'])
    execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])

    const url = `file://${remote}`
    const checksum = '0'.repeat(64)
    await mkdir(path.join(root, '.config/repo'), { recursive: true })
    execFileSync('git', ['init', root])
    await writeFile(path.join(root, '.gitmodules'), `# ${definition.name}-v1.0.0 sha256:${checksum}\n[submodule "upstream/${definition.name}"]\n\tpath = upstream/${definition.name}\n\turl = ${url}\n\tref = ${acceptedSha} # v1.0.0\n\tbranch = v1.0.0\n\tshallow = true\n\tsparse-checkout = ${definition.sparse}\n`)
    await writeFile(path.join(root, '.config/repo/lockstep.json'), `${JSON.stringify({
      upstreams: { [definition.name]: { submodule: `upstream/${definition.name}`, repo: url } },
      rows: [{ kind: 'version-pin', id: definition.name, upstream: definition.name, pinned_tag: 'v1.0.0' }],
    }, null, 2)}\n`)
    await writeFile(path.join(root, 'mise.toml'), `[tools]\n${definition.tool} = "1.0.0"\n`)
    await mkdir(path.join(root, 'scripts/upstream'), { recursive: true })
    await writeFile(path.join(root, 'scripts/upstream/main.mjs'), await readFile(manager, 'utf8'))
    await writeFile(path.join(root, 'scripts/upstream/feature-review.mjs'), await readFile(new URL('./feature-review.mjs', import.meta.url), 'utf8'))
    for (const file of definition.adapter) await writeFile(path.join(root, file), file.endsWith('_test.go') ? 'package jactionlint\n' : definition.name === 'shellcheck' ? 'package jactionlint\nconst shellRule = "SC1234"\n' : 'package jactionlint\n')

    const archive = Buffer.from(`${definition.name} candidate archive`)
    const server = createServer((request, response) => {
      if (request.url !== `/archive/${candidateSha}`) { response.writeHead(404).end(); return }
      response.writeHead(200).end(archive)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const env = {
      ...process.env,
      JACTIONLINT_UPSTREAM_TEST_ROOT: root,
      JACTIONLINT_UPSTREAM_TEST_REPO: definition.name,
      JACTIONLINT_UPSTREAM_TEST_URL: url,
      JACTIONLINT_UPSTREAM_TEST_ARCHIVE: `http://127.0.0.1:${server.address().port}/archive`,
    }
    const run = (...args) => spawnSync(process.execPath, [manager, definition.name, ...args], { cwd: root, env, encoding: 'utf8' })
    const runAsync = (...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [manager, definition.name, ...args], { cwd: root, env })
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.on('error', reject)
      child.on('close', status => resolve({ status, stdout, stderr }))
    })

    const plan = await runAsync('update')
    assert.equal(plan.status, 0, plan.stderr)
    await assert.rejects(readdir(path.join(root, 'upstream')), 'report-only update leaves the local reference uninitialized')
    const receipt = JSON.parse(plan.stdout).verification
    assert.equal(receipt.checks.at(-1).status, 'review-required')
    assert.equal(receipt.detection_audit.changed_detection_sources[0], definition.file)
    if (definition.name === 'shellcheck') assert.deepEqual(receipt.detection_audit.local_review_files, ['rule_shellcheck.go', 'rule_shellcheck_test.go'])
    else assert.deepEqual(receipt.detection_audit.local_review_files, ['rule_pyflakes.go', 'rule_pyflakes_test.go'])

    const reviewOnly = await runAsync('update', '--apply-latest')
    assert.equal(reviewOnly.status, 0, reviewOnly.stderr)
    assert.match(reviewOnly.stderr, /requires source review; pin unchanged/)
    await assert.rejects(readdir(path.join(root, 'upstream')), 'review-only updates must not initialize a local reference')

    const applied = await runAsync('update', '--apply', 'v1.0.1', candidateSha, '--accept-reviewed')
    assert.equal(applied.status, 0, applied.stderr)
    assert.deepEqual(await readdir(path.join(root, 'upstream')), [definition.name], 'applying initializes only the selected reference')
    assert.match(await readFile(path.join(root, 'mise.toml'), 'utf8'), /1\.0\.1/)
    assert.equal(run('check').status, 0)
  }
})
