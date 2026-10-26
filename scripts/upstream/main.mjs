#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewLeads } from './feature-review.mjs'

export { reviewLeads }

const root = path.resolve(process.env.JACTIONLINT_UPSTREAM_TEST_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const repositories = {
  actionlint: {
    name: 'actionlint', path: 'upstream/actionlint',
    url: 'https://github.com/rhysd/actionlint.git',
    archive: 'https://codeload.github.com/rhysd/actionlint/tar.gz',
    sparsePaths: ['/*.go', '/go.mod', '/go.sum', '/cmd/**', '/testdata/err/**', '/testdata/examples/**'],
    kind: 'pattern-review',
  },
  zizmor: {
    name: 'zizmor', path: 'upstream/zizmor',
    url: 'https://github.com/zizmorcore/zizmor.git',
    archive: 'https://codeload.github.com/zizmorcore/zizmor/tar.gz',
    sparsePaths: ['/crates/zizmor/src/audit/**'], kind: 'pattern-review',
  },
  shellcheck: {
    name: 'shellcheck', path: 'upstream/shellcheck',
    url: 'https://github.com/koalaman/shellcheck.git',
    archive: 'https://codeload.github.com/koalaman/shellcheck/tar.gz',
    sparsePaths: ['/src/**', '/test/**', '/ShellCheck.cabal', '/LICENSE'], kind: 'pattern-review',
  },
  pyflakes: {
    name: 'pyflakes', path: 'upstream/pyflakes',
    url: 'https://github.com/PyCQA/pyflakes.git',
    archive: 'https://codeload.github.com/PyCQA/pyflakes/tar.gz',
    sparsePaths: ['/pyflakes/**', '/setup.py', '/setup.cfg', '/LICENSE'], kind: 'pattern-review',
  },
}
let repo = repositories.actionlint
let sparsePaths = repo.sparsePaths

function selectRepository(name) {
  const definition = repositories[name]
  if (!definition) throw new Error(`unknown upstream ${name}; choose one of ${Object.keys(repositories).join(', ')}`)
  repo = { ...definition }
  if (name === 'actionlint' || process.env.JACTIONLINT_UPSTREAM_TEST_REPO === name) {
    repo.url = process.env.JACTIONLINT_UPSTREAM_TEST_URL ?? repo.url
    repo.archive = process.env.JACTIONLINT_UPSTREAM_TEST_ARCHIVE ?? repo.archive
  }
  sparsePaths = repo.sparsePaths
}

function isTestRepositoryOverride() {
  return repo.name === 'actionlint' || process.env.JACTIONLINT_UPSTREAM_TEST_REPO === repo.name
}

export function parseSubmodules(text) {
  const blocks = []
  let current
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[submodule\s+"([^"]+)"\]\s*$/.exec(line)
    if (header) {
      if (current) blocks.push(current)
      current = { name: header[1], fields: Object.create(null), lines: [] }
    } else if (current) {
      current.lines.push(line)
      const field = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (field) current.fields[field[1]] = field[2].replace(/\s+#.*$/, '')
    }
  }
  if (current) blocks.push(current)
  return blocks
}

function git(args, cwd = root, inherit = false) {
  const configured = process.env.JACTIONLINT_UPSTREAM_TEST_GIT ? JSON.parse(process.env.JACTIONLINT_UPSTREAM_TEST_GIT) : ['git']
  const [command, ...prefix] = configured
  const output = execFileSync(command, [...prefix, ...args], {
    cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    timeout: 300_000,
  })
  return typeof output === 'string' ? output.trim() : ''
}

async function readPin() {
  const text = await readFile(path.join(root, '.gitmodules'), 'utf8')
  const entry = parseSubmodules(text).find(block => block.fields.path === repo.path)
  if (!entry) throw new Error(`.gitmodules has no ${repo.path} entry`)
  const { ref, branch, shallow, url } = entry.fields
  const refLine = entry.lines.find(line => /^\s*ref\s*=/.test(line)) ?? ''
  const label = /#\s*(v?\d+\.\d+\.\d+)\s*$/.exec(refLine)?.[1]
  const section = text.split(/\r?\n/)
  const headerIndex = section.findIndex(line => line.trim() === `[submodule "${entry.name}"]`)
  const integrityMatch = new RegExp(`^#\\s*${repo.name}-(v?\\d+\\.\\d+\\.\\d+) sha256:([0-9a-f]{64})$`).exec(section[headerIndex - 1]?.trim() ?? '')
  const integrity = integrityMatch?.[2]
  if (!/^[0-9a-f]{40}$/.test(ref ?? '')) throw new Error(`${repo.path} ref must be a full commit SHA`)
  if (!/^v?\d+\.\d+\.\d+$/.test(branch ?? '') || !label || branch !== label) throw new Error(`${repo.path} branch must match its release-tag ref comment`)
  if (shallow !== 'true') throw new Error(`${repo.path} must set shallow = true`)
  if ((entry.fields['sparse-checkout'] ?? '').split(/\s+/).join('\n') !== sparsePaths.join('\n')) throw new Error(`${repo.path} sparse-checkout must match the declared source and fixture paths`)
  if (!integrity || integrityMatch[1] !== label) throw new Error(`${repo.path} needs a matching archive sha256 comment immediately above its submodule block`)
  const expectedUrl = isTestRepositoryOverride() ? (process.env.JACTIONLINT_UPSTREAM_TEST_URL ?? repo.url) : repo.url
  if (url !== expectedUrl) throw new Error(`${repo.path} URL differs from the declared upstream`)
  const manifest = JSON.parse(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8'))
  const row = manifest.rows.find(item => item.kind === 'version-pin' && item.id === repo.name)
  if (!row || row.upstream !== repo.name || row.pinned_tag !== label || 'pinned_sha' in row) throw new Error('lockstep row must match the upstream pin label and derive its SHA from .gitmodules')
  const manifestUpstream = manifest.upstreams?.[repo.name]
  const metadataUrl = (manifestUpstream?.repo ?? '').replace(/\.git$/, '')
  const declaredUrl = url.replace(/\.git$/, '')
  if (!manifestUpstream || manifestUpstream.submodule !== repo.path || metadataUrl !== declaredUrl) throw new Error(`${repo.name} upstream metadata does not match the declared repository`)
  if (!isTestRepositoryOverride() || !process.env.JACTIONLINT_UPSTREAM_TEST_URL) {
    if (metadataUrl !== repo.url.replace(/\.git$/, '')) throw new Error(`${repo.name} metadata URL differs from its declared upstream`)
  }
  const toolName = { shellcheck: 'shellcheck', pyflakes: 'pipx:pyflakes', zizmor: 'zizmor' }[repo.name]
  if (toolName && readToolPin(await readFile(path.join(root, 'mise.toml'), 'utf8'), toolName) !== label.replace(/^v/, '')) throw new Error(`mise.toml ${toolName} tool version does not match the accepted ${label} pin`)
  if (repo.name === 'zizmor') {
    const mapping = JSON.parse(await readFile(path.join(root, 'scripts/zizmor-diff/mapping.json'), 'utf8'))
    if (mapping.zizmor !== label.replace(/^v/, '')) throw new Error(`zizmor-diff mapping version does not match ${label}`)
  }
  return { text, entry, ref, tag: label, integrity }
}

function readToolPin(text, tool) {
  const key = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*"?${key}"?\\s*=\\s*"([^"]+)"`, 'm').exec(text)?.[1]
}

function gitDir(dir) {
  return path.resolve(dir, git(['-C', dir, 'rev-parse', '--git-dir']))
}

function repositoryGitDir() {
  return path.resolve(root, git(['rev-parse', '--git-dir']))
}

function isGitRepo(dir) {
  try {
    if (!existsSync(path.join(dir, '.git'))) return false
    // --show-prefix is empty only when dir is the Git worktree root. This
    // avoids comparing Windows paths that Git may report using 8.3 aliases.
    return git(['-C', dir, 'rev-parse', '--show-prefix']) === ''
  } catch { return false }
}

async function sparse(dir) {
  git(['-C', dir, 'config', 'core.sparseCheckout', 'true'])
  git(['-C', dir, 'config', 'core.sparseCheckoutCone', 'false'])
  await writeFile(path.join(gitDir(dir), 'info/sparse-checkout'), `${sparsePaths.join('\n')}\n`)
}

async function materialize(dir, sha) {
  if (isGitRepo(dir)) {
    const dirty = git(['-C', dir, 'status', '--porcelain'])
    if (dirty) throw new Error(`${dir} has local changes; refusing to update the reference checkout`)
    if (git(['-C', dir, 'remote', 'get-url', 'origin']) !== repo.url) throw new Error(`${dir} origin URL differs from ${repo.url}`)
  } else {
    try {
      const entries = await readdir(dir)
      if (entries.length) throw new Error(`${dir} exists but is not the upstream repository; preserving its contents`)
      await rmdir(dir)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--single-branch', repo.url, dir], root, true)
  }
  await sparse(dir)
  const head = isGitRepo(dir) ? git(['-C', dir, 'rev-parse', 'HEAD']) : ''
  if (head !== sha) {
    try { git(['-C', dir, 'cat-file', '-e', `${sha}^{commit}`]) }
    catch { git(['-C', dir, 'fetch', '--depth', '1', 'origin', sha], root, true) }
  }
  git(['-C', dir, 'checkout', '--force', '--detach', sha], root, true)
  git(['-C', dir, 'read-tree', '-mu', 'HEAD'])
  const actual = git(['-C', dir, 'rev-parse', 'HEAD'])
  if (actual !== sha) throw new Error(`materialized ${actual}; expected ${sha}`)
}

async function ensureAcceptedCheckout(pin) {
  const dir = path.join(root, repo.path)
  if (!isGitRepo(dir)) {
    let entries = []
    try { entries = await readdir(dir) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (entries.length) throw new Error(`${dir} exists but is not the upstream repository; preserving its contents`)
    await materialize(dir, pin.ref)
  }
  if (git(['-C', dir, 'remote', 'get-url', 'origin']) !== repo.url) throw new Error(`${dir} origin URL differs from ${repo.url}`)
  if (git(['-C', dir, 'status', '--porcelain'])) throw new Error(`${dir} has local changes; refusing to start an update transaction`)
  if (git(['-C', dir, 'rev-parse', 'HEAD']) !== pin.ref) throw new Error(`${dir} does not match the accepted pin; run mise run upstream:setup before applying an update`)
}

export async function check() {
  const pin = await readPin()
  const dir = path.join(root, repo.path)
  let entries = []
  try { entries = await readdir(dir) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!entries.length && !isGitRepo(dir)) {
    console.log(`${repo.name} ${pin.tag} ${pin.ref}: pin valid; sparse reference not materialized`)
    return
  }
  if (!isGitRepo(dir)) throw new Error(`${dir} exists but is not an upstream repository; preserving its contents`)
  const head = git(['-C', dir, 'rev-parse', 'HEAD'])
  const patterns = await readFile(path.join(gitDir(dir), 'info/sparse-checkout'), 'utf8')
  const origin = git(['-C', dir, 'remote', 'get-url', 'origin'])
  const shallow = git(['-C', dir, 'rev-parse', '--is-shallow-repository'])
  const sparseEnabled = git(['-C', dir, 'config', '--bool', 'core.sparseCheckout'])
  const sparseCone = git(['-C', dir, 'config', '--bool', 'core.sparseCheckoutCone'])
  let attached = false
  try { git(['-C', dir, 'symbolic-ref', '--quiet', 'HEAD']); attached = true } catch { /* Detached HEAD is required. */ }
  const gitlinks = git(['ls-files', '--stage', '--', 'upstream']).split(/\r?\n/).filter(line => /^160000\s/.test(line))
  if (head !== pin.ref || origin !== repo.url || shallow !== 'true' || attached || sparseEnabled !== 'true' || sparseCone !== 'false' || patterns.trim() !== sparsePaths.join('\n') || gitlinks.length || git(['-C', dir, 'status', '--porcelain'])) {
    throw new Error(`${repo.path} does not match its accepted SHA, origin, shallow detached sparse checkout contract, or has local changes/gitlinks; run mise run upstream:setup`)
  }
  console.log(`${repo.name} ${pin.tag} ${head}: current`)
}

function version(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return match ? match.slice(1).map(Number) : null
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function latestRelease(output) {
  const lines = output.split(/\r?\n/).filter(Boolean)
  const peeled = new Map(lines.flatMap(line => {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(v?\d+\.\d+\.\d+)\^\{\}$/.exec(line)
    return match ? [[match[2], match[1]]] : []
  }))
  const releases = lines.map(line => {
    const [sha, ref] = line.split(/\s+/)
    if (ref.endsWith('^{}')) return null
    const tag = ref.replace('refs/tags/', '')
    const parsed = version(tag)
    const commit = peeled.get(tag) ?? sha
    return parsed && /^[0-9a-f]{40}$/.test(commit) ? { sha: commit, tag, version: parsed } : null
  }).filter(Boolean).sort((a, b) => compareVersion(a.version, b.version))
  if (!releases.length) throw new Error('no stable vMAJOR.MINOR.PATCH tags found')
  return releases.at(-1)
}

function releaseFromRemote() {
  return latestRelease(git(['ls-remote', '--tags', repo.url]))
}

function assertReleaseUnchanged(expected) {
  const current = releaseFromRemote()
  if (current.tag !== expected.tag || current.sha !== expected.sha) {
    throw new Error(`release ${expected.tag} moved during verification; rerun mise run upstream:update`)
  }
}

async function hashArchive(sha) {
  const hash = createHash('sha256')
  const response = await new Promise((resolve, reject) => {
    const client = repo.archive.startsWith('http://') ? http : https
    const archiveRef = process.env.JACTIONLINT_UPSTREAM_TEST_ARCHIVE_REF ?? sha
    const request = client.get(`${repo.archive}/${archiveRef}`, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`archive request returned HTTP ${res.statusCode}`)); return }
      resolve(res)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('archive request timed out after 30 seconds')))
    request.on('error', reject)
  })
  response.on('data', chunk => hash.update(chunk))
  await new Promise((resolve, reject) => response.on('end', resolve).on('error', reject))
  return hash.digest('hex')
}

export function classifyFiles(kind, files, name = 'actionlint') {
  if (kind !== 'pattern-review') return files.map(file => ({ file, classification: 'source-review-required' }))
  return files.map(file => {
    if (name === 'actionlint') {
      if (/^testdata\/(?:err|examples)\//.test(file)) return { file, classification: 'pattern-fixture-review' }
      if (/\.go$/i.test(file) && /_test\.go$/i.test(file)) return { file, classification: 'detection-test-review' }
      if (/\.go$/i.test(file)) return { file, classification: 'detection-source-review' }
    } else if (name === 'zizmor') {
      if (/\/audit\/.*\.rs$/.test(`/${file}`) && /_test\.rs$/.test(file)) return { file, classification: 'detection-test-review' }
      if (/\/audit\/.*\.rs$/.test(`/${file}`)) return { file, classification: 'detection-source-review' }
      if (/\/audit\/.*\.(?:yaml|yml|json|toml)$/.test(`/${file}`)) return { file, classification: 'pattern-fixture-review' }
    } else if (name === 'shellcheck') {
      if (/^test\//.test(file)) return { file, classification: 'detection-test-review' }
      if (/^src\/.+\.(?:json|sh|bash|dash|ksh|bats)$/.test(file)) return { file, classification: 'pattern-fixture-review' }
      if (/^src\//.test(file)) return { file, classification: 'detection-source-review' }
    } else if (name === 'pyflakes') {
      if (/^pyflakes\/test\//.test(file)) return { file, classification: 'detection-test-review' }
      if (/^pyflakes\/test\/.*\.(?:py|txt)$/.test(file)) return { file, classification: 'pattern-fixture-review' }
      if (/^pyflakes\/(?:checker|messages|api)\.py$/.test(file)) return { file, classification: 'detection-source-review' }
    }
    return { file, classification: 'source-review-required' }
  })
}

function classify(files) {
  return classifyFiles(repo.kind, files, repo.name)
}

function changedFiles(dir, oldSha, newSha) {
  git(['-C', dir, 'fetch', '--depth', '1', 'origin', oldSha], root, true)
  return git(['-C', dir, 'diff', '--name-only', `${oldSha}..${newSha}`], root).split(/\r?\n/).filter(Boolean)
}

function verifierInputs() {
  const common = ['.gitmodules', '.config/repo/lockstep.json', 'mise.toml', 'scripts/upstream/main.mjs', 'scripts/upstream/feature-review.mjs']
  if (repo.name === 'actionlint') {
    const goFiles = git(['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.go']).split(/\r?\n/).filter(Boolean)
    return [...new Set([...common, ...goFiles])]
  }
  const projectInputs = repo.name === 'zizmor' ? ['scripts/zizmor-diff/mapping.json']
    : repo.name === 'shellcheck' ? ['rule_shellcheck.go', 'rule_shellcheck_test.go']
      : ['rule_pyflakes.go', 'rule_pyflakes_test.go']
  return [...new Set([...common, ...projectInputs])]
}

async function digestInputs() {
  const hash = createHash('sha256')
  const files = verifierInputs()
  const uniqueFiles = [...new Set(files)].sort()
  for (const file of uniqueFiles) hash.update(file).update(await readFile(path.join(root, file)))
  return { count: uniqueFiles.length, digest: hash.digest('hex') }
}

function gitBlob(dir, sha, file) {
  git(['-C', dir, 'cat-file', '-e', `${sha}^{commit}`])
  if (!git(['-C', dir, 'ls-tree', '-r', '--name-only', sha, '--', file])) return ''
  return git(['-C', dir, 'show', `${sha}:${file}`])
}

function localReviewIndex(name) {
  if (name === 'zizmor') {
    const mapping = JSON.parse(requireText(path.join(root, 'scripts/zizmor-diff/mapping.json')))
    return Object.fromEntries(Object.entries(mapping.audits ?? {}).map(([id, row]) => [id, row.jactionlint.map(item => item.rule)]))
  }
  if (name === 'actionlint') {
    const rules = readdirSync(root).filter(file => /^rule_.*\.go$/.test(file)).flatMap(file => {
      const text = readFileSync(path.join(root, file), 'utf8')
      return [...text.matchAll(/^type (Rule[A-Za-z0-9]+) struct/gm)].map(match => [match[1], `${match[1]} (${file})`])
    })
    return Object.fromEntries(rules)
  }
  if (name === 'shellcheck') {
    return { __review_files: ['rule_shellcheck.go', 'rule_shellcheck_test.go'] }
  }
  return { __review_files: ['rule_pyflakes.go', 'rule_pyflakes_test.go'] }
}

function requireText(file) {
  return readFileSync(file, 'utf8')
}

async function verifyCandidate(sha, tag, candidateDir) {
  const inputsBefore = await digestInputs()
  const pin = await readPin()
  await materialize(candidateDir, sha, tag)
  const changes = classify(changedFiles(candidateDir, pin.ref, sha))
  const before = Object.fromEntries(changes.map(({ file }) => [file, gitBlob(candidateDir, pin.ref, file)]))
  const after = Object.fromEntries(changes.map(({ file }) => [file, gitBlob(candidateDir, sha, file)]))
  const featureReviewLeads = reviewLeads(repo.name, changes, before, after, localReviewIndex(repo.name))
  let inputs = { count: 0, digest: '' }, checks, extra = {}, failed = false
  if (repo.name === 'zizmor') {
    const acceptedAudits = await auditIds(candidateDir, pin.ref)
    const candidateAudits = await auditIds(candidateDir, sha)
    if (!candidateAudits.length || (acceptedAudits.length > 0 && candidateAudits.length < acceptedAudits.length / 2)) {
      throw new Error(`zizmor audit extraction found ${candidateAudits.length} audits at ${tag} (accepted: ${acceptedAudits.length}); refusing an incomplete inventory`)
    }
    const mapping = JSON.parse(await readFile(path.join(root, 'scripts/zizmor-diff/mapping.json'), 'utf8'))
    const mapped = new Set(Object.keys(mapping.audits ?? {}))
    extra.audit_inventory = {
      mapped_audits: candidateAudits.filter(id => mapped.has(id)),
      existing_unmapped_audits: acceptedAudits.filter(id => !mapped.has(id)),
      new_audits: candidateAudits.filter(id => !acceptedAudits.includes(id)),
      new_unmapped_audits: candidateAudits.filter(id => !acceptedAudits.includes(id) && !mapped.has(id)),
    }
    checks = [{ command: 'compare upstream audit IDs and changed scan behavior with local detections and fixtures', status: changes.length ? 'review-required' : 'passed' }]
  } else {
    checks = []
  }
  inputs = await digestInputs()
  const inputsChanged = inputs.digest !== inputsBefore.digest
  if (inputsChanged) {
    failed = true
    checks.push({ command: 'keep verification inputs unchanged while preparing the report', status: 'failed' })
  }
  const detectionAudit = {
    unmatched_detection_symbols: [...new Set(featureReviewLeads.flatMap(lead => lead.added_symbols.filter(symbol =>
      !featureReviewLeads.some(candidate => candidate.local_matches.some(match => match.upstream_symbol === symbol)),
    )))].sort(),
    changed_detection_sources: changes.filter(item => item.classification === 'detection-source-review').map(item => item.file),
    changed_detection_tests: changes.filter(item => item.classification === 'detection-test-review').map(item => item.file),
    changed_pattern_fixtures: changes.filter(item => item.classification === 'pattern-fixture-review').map(item => item.file),
    likely_local_rules: [...new Set(featureReviewLeads.flatMap(lead => lead.local_matches.map(match => match.local)))].sort(),
    local_review_files: [...new Set(featureReviewLeads.flatMap(lead => lead.local_review_files))].sort(),
    scope: `upstream ${repo.name} detection source, tests, and pattern fixtures changed since the accepted pin; review these for behavior jactionlint should cover`,
  }
  checks.push({
    command: `review ${repo.name} detection patterns, scans, tests, and fixtures against jactionlint behavior`,
    status: changes.length ? 'review-required' : 'passed',
    ...detectionAudit,
  })
  return {
    version: 1, accepted_sha: pin.ref, candidate_sha: sha, candidate_tag: tag,
    changed_files: changes,
    feature_review_leads: featureReviewLeads,
    feature_review_scope: 'heuristic links from changed upstream code to likely local rule types; review upstream code and tests before deciding whether behavior is covered',
    verification_input_patterns: verifierInputs(),
    verification_input_count: inputs.count, verification_input_digest: inputs.digest,
    verification_scope: `lists changed ${repo.name} detection source, tests, patterns, and fixtures for behavior review; project regression tests run separately`,
    checks,
    source_review_required: changes.filter(item => item.classification === 'source-review-required'),
    review_required: changes.length > 0,
    passed: !failed,
    ...extra,
    detection_audit: detectionAudit,
  }
}

async function auditIds(dir, sha) {
  const files = git(['-C', dir, 'ls-tree', '-r', '--name-only', sha, 'crates/zizmor/src/audit']).split(/\r?\n/).filter(file => file.endsWith('.rs') && !file.endsWith('/mod.rs'))
  const ids = new Set()
  for (const file of files) {
    const source = git(['-C', dir, 'show', `${sha}:${file}`]).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    for (const match of source.matchAll(/audit_meta!\(\s*[^,]+,\s*"([a-z0-9-]+)"/gs)) ids.add(match[1])
  }
  return [...ids].sort()
}

async function update(args) {
  const applyLatest = args[0] === '--apply-latest'
  const applying = args[0] === '--apply' || applyLatest
  if (applyLatest && args.length !== 1) throw new Error('automatic update accepts no extra arguments')
  const inputsBeforeDownload = await digestInputs()
  const pin = await readPin()
  const target = releaseFromRemote()
  if (compareVersion(target.version, version(pin.tag)) < 0) throw new Error(`latest tag ${target.tag} would downgrade ${pin.tag}`)
  if (args[0] === '--apply') {
    if (args.length !== 4 || args[3] !== '--accept-reviewed') throw new Error('apply requires: update --apply <tag> <candidate-sha> --accept-reviewed')
    if (args[1] !== target.tag) throw new Error(`requested ${args[1]}, current latest release is ${target.tag}; rerun mise run upstream:update`)
    if (args[2] !== target.sha) throw new Error(`candidate SHA changed since review; expected ${args[2]}, current tag resolves to ${target.sha}`)
    if (pin.ref === target.sha) throw new Error(`${target.tag} is already the accepted pin; there is nothing to apply`)
  }
  const sha256 = await hashArchive(target.sha)
  if ((await digestInputs()).digest !== inputsBeforeDownload.digest) throw new Error('verification inputs changed while downloading the candidate archive; rerun mise run upstream:update')
  assertReleaseUnchanged(target)
  if (target.sha === pin.ref && sha256 !== pin.integrity) throw new Error(`archive hash for accepted ${pin.tag} differs from its recorded checksum`)
  const plan = { current: { sha: pin.ref, tag: pin.tag }, candidate: { sha: target.sha, tag: target.tag, sha256 } }
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jactionlint-upstream-'))
  try {
    const receipt = await verifyCandidate(target.sha, target.tag, path.join(temp, repo.name))
    assertReleaseUnchanged(target)
    console.log(JSON.stringify({ ...plan, verification: receipt }, null, 2))
    if (!receipt.passed) throw new Error('candidate verification failed or has unmapped changes; accepted pin unchanged')
    if (!applying || pin.ref === target.sha) return
    if (applyLatest && receipt.review_required) {
      console.error(`upstream: ${repo.name} ${target.tag} requires source review; pin unchanged. After review, run:\nmise exec node@lts -- node ./scripts/upstream/main.mjs ${repo.name} update --apply ${target.tag} ${target.sha} --accept-reviewed`)
      return
    }
    if (pin.ref !== target.sha) await ensureAcceptedCheckout(pin)
    if ((await digestInputs()).digest !== receipt.verification_input_digest) throw new Error('verification inputs changed after candidate review; rerun mise run upstream:update')
    const edits = [
      [`# ${repo.name}-${pin.tag} sha256:${pin.integrity}`, `# ${repo.name}-${target.tag} sha256:${sha256}`],
      [`ref = ${pin.ref} # ${pin.tag}`, `ref = ${target.sha} # ${target.tag}`],
      [`branch = ${pin.tag}`, `branch = ${target.tag}`],
    ]
    const sections = [...pin.text.matchAll(/^[\t ]*\[([^\r\n]+)\][\t ]*\r?$/gm)]
    const selectedSections = sections.filter(section => section[1] === `submodule "${pin.entry.name}"`)
    if (selectedSections.length !== 1) throw new Error('could not locate the selected .gitmodules section exactly once; accepted pin unchanged')
    const selected = selectedSections[0]
    // Include the checksum comment immediately above this project's section.
    const start = pin.text.lastIndexOf('\n', selected.index - 2) + 1
    const end = sections[sections.indexOf(selected) + 1]?.index ?? pin.text.length
    let updatedSection = pin.text.slice(start, end)
    for (const [from, to] of edits) {
      const first = updatedSection.indexOf(from)
      if (first < 0 || updatedSection.indexOf(from, first + from.length) >= 0) throw new Error('could not update each expected .gitmodules entry exactly once; accepted pin unchanged')
      updatedSection = `${updatedSection.slice(0, first)}${to}${updatedSection.slice(first + from.length)}`
    }
    const updated = `${pin.text.slice(0, start)}${updatedSection}${pin.text.slice(end)}`
    const gm = path.join(root, '.gitmodules')
    const manifestPath = path.join(root, '.config/repo/lockstep.json')
    const misePath = path.join(root, 'mise.toml')
    const mappingPath = path.join(root, 'scripts/zizmor-diff/mapping.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const row = manifest.rows.find(item => item.kind === 'version-pin' && item.id === repo.name)
    if (!row) throw new Error(`lockstep manifest has no ${repo.name} version-pin row`)
    row.pinned_tag = target.tag
    const manifestUpdated = `${JSON.stringify(manifest, null, 2)}\n`
    let miseText = await readFile(misePath, 'utf8')
    if (repo.name === 'shellcheck') miseText = replaceToolPin(miseText, 'shellcheck', pin.tag, target.tag)
    if (repo.name === 'pyflakes') miseText = replaceToolPin(miseText, 'pipx:pyflakes', pin.tag, target.tag)
    if (repo.name === 'zizmor') miseText = replaceToolPin(miseText, 'zizmor', pin.tag, target.tag)
    let mappingText
    if (repo.name === 'zizmor') {
      const mapping = JSON.parse(await readFile(mappingPath, 'utf8'))
      mapping.zizmor = target.tag.replace(/^v/, '')
      mappingText = `${JSON.stringify(mapping, null, 2)}\n`
    }
    assertReleaseUnchanged(target)
    if ((await digestInputs()).digest !== receipt.verification_input_digest) throw new Error('verification inputs changed before applying the candidate; rerun mise run upstream:update')
    const transactionPath = path.join(repositoryGitDir(), 'jactionlint-upstream-apply.json')
    const files = {
      '.gitmodules': { before: await readFile(gm, 'utf8'), after: updated },
      '.config/repo/lockstep.json': { before: await readFile(manifestPath, 'utf8'), after: manifestUpdated },
      'mise.toml': { before: await readFile(misePath, 'utf8'), after: miseText },
      ...(mappingText ? { 'scripts/zizmor-diff/mapping.json': { before: await readFile(mappingPath, 'utf8'), after: mappingText } } : {}),
    }
    const transaction = {
      files, upstream: repo.name, old_sha: pin.ref, new_sha: target.sha, old_tag: pin.tag,
    }
    await writeFile(`${transactionPath}.tmp`, `${JSON.stringify(transaction)}\n`)
    await rename(`${transactionPath}.tmp`, transactionPath)
    try {
      for (const [file, values] of Object.entries(files)) await atomicWrite(path.join(root, file), values.after)
      await materialize(path.join(root, repo.path), target.sha)
      await rm(transactionPath, { force: true })
    } catch (error) {
      try { await recoverInterruptedApply() }
      catch (recoveryError) { throw new Error(`${error.message}; upstream apply recovery failed: ${recoveryError.message}`) }
      throw error
    }
  } finally { await rm(temp, { recursive: true, force: true }) }
}

export async function runSources(names, command, requestedName, run) {
  const errors = []
  for (const name of names) {
    try { await run(name) }
    catch (error) {
      if (command !== 'update' || requestedName) throw error
      errors.push(`${name}: ${error.message}`)
    }
  }
  if (errors.length) throw new Error(`upstream update incomplete:\n${errors.join('\n')}`)
}

function replaceToolPin(text, tool, oldTag, newTag) {
  const key = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const oldVersion = oldTag.replace(/^v/, '')
  const line = new RegExp(`^(\\s*"?${key}"?\\s*=\\s*")${oldVersion.replace(/\./g, '\\.')}("\\s*(?:#.*)?$)`, 'm')
  if (!line.test(text)) throw new Error(`mise.toml has no exact ${tool} pin at ${oldVersion}`)
  return text.replace(line, `$1${newTag.replace(/^v/, '')}$2`)
}

async function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
}

async function recoverInterruptedApply() {
  const transactionPath = path.join(repositoryGitDir(), 'jactionlint-upstream-apply.json')
  let transaction
  try { transaction = JSON.parse(await readFile(transactionPath, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return
    throw new Error(`cannot read upstream apply recovery record at ${transactionPath}: ${error.message}`)
  }
  const allowedFiles = new Set(['.gitmodules', '.config/repo/lockstep.json', 'mise.toml', 'scripts/zizmor-diff/mapping.json'])
  const fileEntries = Object.entries(transaction.files ?? {})
  if (!repositories[transaction.upstream] || !/^[0-9a-f]{40}$/.test(transaction.old_sha ?? '') || !/^[0-9a-f]{40}$/.test(transaction.new_sha ?? '') || !/^v?\d+\.\d+\.\d+$/.test(transaction.old_tag ?? '') ||
    !fileEntries.some(([file]) => file === '.gitmodules') || !fileEntries.some(([file]) => file === '.config/repo/lockstep.json') ||
    fileEntries.some(([file, values]) => !allowedFiles.has(file) || typeof values?.before !== 'string' || typeof values?.after !== 'string') ||
    ((transaction.upstream === 'zizmor') !== fileEntries.some(([file]) => file === 'scripts/zizmor-diff/mapping.json'))) {
    throw new Error(`upstream apply recovery record at ${transactionPath} is invalid`)
  }
  const selectedName = repo.name
  selectRepository(transaction.upstream)
  const dir = path.join(root, repo.path)
  if (isGitRepo(dir)) {
    if (git(['-C', dir, 'remote', 'get-url', 'origin']) !== repo.url) throw new Error(`${dir} origin URL differs from ${repo.url}; refusing recovery`)
    if (git(['-C', dir, 'status', '--porcelain'])) throw new Error(`${dir} has local changes; refusing recovery and preserving the checkout`)
    const head = git(['-C', dir, 'rev-parse', 'HEAD'])
    if (head !== transaction.old_sha && head !== transaction.new_sha) throw new Error(`${dir} moved to ${head} during recovery; refusing to change the checkout`)
  }
  const currentFiles = await Promise.all(fileEntries.map(async ([file, values]) => [file, values, await readFile(path.join(root, file), 'utf8')]))
  const changedFiles = currentFiles.filter(([, values, current]) => current !== values.before && current !== values.after).map(([file]) => file)
  if (changedFiles.length) throw new Error(`tracked metadata changed since interrupted apply (${changedFiles.join(', ')}); preserving edits and recovery record`)
  for (const [file, values] of fileEntries) await atomicWrite(path.join(root, file), values.before)
  await materialize(dir, transaction.old_sha)
  await rm(transactionPath, { force: true })
  selectRepository(selectedName)
}

async function withLock(action) {
  const lockPath = path.join(repositoryGitDir(), 'jactionlint-upstream.lock')
  const token = randomUUID()
  for (;;) {
    try {
      await mkdir(lockPath)
      await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, token })}\n`)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) }
      catch { throw new Error(`another upstream manager command is starting or the lock needs manual cleanup (lock: ${lockPath})`) }
      throw new Error(`another upstream manager command owns the lock (pid ${owner.pid}; remove ${lockPath} only after confirming that process has stopped)`)
    }
  }
  try { return await action() }
  finally {
    const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'))
    if (owner.token === token) await rm(lockPath, { recursive: true, force: true })
  }
}

async function main(argv) {
  const cliName = argv[0] && Object.hasOwn(repositories, argv[0]) ? argv.shift() : undefined
  const requestedName = cliName ?? process.env.JACTIONLINT_UPSTREAM_NAME
  const [command, ...args] = argv
  const manifest = JSON.parse(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8'))
  const names = requestedName ? [requestedName] : Object.keys(manifest.upstreams ?? {})
  if (!names.length || names.some(name => !Object.hasOwn(repositories, name))) throw new Error('lockstep manifest has an unknown or empty upstream list')
  if (args[0] === '--apply' && !requestedName && names.length > 1) throw new Error('choose one upstream before applying a reviewed release')
  await withLock(async () => {
    await runSources(names, command, requestedName, async name => {
      selectRepository(name)
      await recoverInterruptedApply()
      if (command === 'setup') {
        const pin = await readPin()
        await materialize(path.join(root, repo.path), pin.ref)
      } else if (command === 'check') await check()
      else if (command === 'update' && (args.length === 0 || args[0] === '--plan')) await update([])
      else if (command === 'update' && (args[0] === '--apply' || args[0] === '--apply-latest')) await update(args)
      else throw new Error(`usage: node scripts/upstream/main.mjs [${Object.keys(repositories).join('|')}] <setup|check|update [--apply-latest|--apply tag sha --accept-reviewed]>`)
    })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`upstream: ${error.message}`); process.exitCode = 1 })
}
