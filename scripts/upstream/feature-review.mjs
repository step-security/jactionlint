// Structural review leads help maintainers find likely upstream feature changes; they do not prove parity.
export function reviewLeads(name, changes, before, after, local = {}) {
  const leads = []
  const unique = values => [...new Set(values)].sort()
  for (const { file } of changes) {
    const oldText = before[file] ?? ''
    const newText = after[file] ?? ''
    const extract = name === 'actionlint' ? /\b(?:type\s+)?(Rule[A-Z][A-Za-z0-9]*|NewRule[A-Z][A-Za-z0-9]*|rule[A-Z][A-Za-z0-9]*)\b/g
      : name === 'zizmor' ? /audit_meta!\([\s\S]*?"([a-z0-9-]+)"/g
        : name === 'shellcheck' ? /(?:SC\d{4}|\b[A-Z][A-Za-z0-9]*Check[A-Za-z0-9]*\b)/gi
          : file === 'pyflakes/messages.py' ? /^class ([A-Z][A-Za-z0-9]+)\(Message\):/gm
            : /\b[A-Z][A-Z]\d{3}\b/g
    const normalize = value => name === 'shellcheck' ? value.toUpperCase() : value
    const oldSymbols = unique([...oldText.matchAll(extract)].map(match => normalize(match[1] ?? match[0])))
    const newSymbols = unique([...newText.matchAll(extract)].map(match => normalize(match[1] ?? match[0])))
    const added = newSymbols.filter(symbol => !oldSymbols.includes(symbol))
    const removed = oldSymbols.filter(symbol => !newSymbols.includes(symbol))
    const relevantPath = name === 'actionlint'
      ? /(?:^|\/)(?:rule_[^/]+\.go|expr_[^/]+\.go|parse\.go|ast\.go|config\.go|action_metadata\.go|availability\.go|all_webhooks\.go|.*\.yaml|.*\.json)$/i.test(file)
      : name === 'zizmor' ? /\/audit\/[^/]+\.rs$/.test(`/${file}`)
        : name === 'shellcheck' ? /^(?:src\/|test\/)/.test(file)
          : /^pyflakes\/(?:checker|messages|api)\.py$|^pyflakes\/test\//.test(file)
    const detectionReviewPath = ['actionlint', 'zizmor', 'shellcheck', 'pyflakes'].includes(name) && changesDetectionBehavior(name, file)
    if (!relevantPath && !detectionReviewPath && added.length === 0 && removed.length === 0) continue
    const retained = newSymbols.filter(symbol => oldSymbols.includes(symbol))
    const candidates = unique([...added, ...(['actionlint', 'zizmor'].includes(name) ? removed : []), ...(relevantPath || detectionReviewPath ? retained : [])])
    const needles = name === 'zizmor' || name === 'actionlint' || name === 'pyflakes' ? candidates
      : candidates.filter(symbol => /^(?:SC\d{4}|[A-Z][A-Za-z0-9]*CHECK[A-Za-z0-9]*)$/.test(symbol))
    const localMatches = needles.flatMap(symbol => local[symbol] ? [{ upstream_symbol: symbol, local: local[symbol] }] : [])
    leads.push({
      file, kind: detectionReviewPath ? 'detection-review' : relevantPath ? 'behavior-source' : 'symbol-change',
      added_symbols: added, removed_symbols: removed,
      local_matches: localMatches,
      local_review_files: local.__review_files ?? [],
      review: added.length || removed.length ? 'inspect-symbol-diff-and-upstream-tests' : 'inspect-source-diff-and-upstream-tests',
    })
  }
  return leads
}

function changesDetectionBehavior(name, file) {
  if (name === 'actionlint') return /\.go$/i.test(file) || /^testdata\/(?:err|examples)\//i.test(file)
  if (name === 'zizmor') return /\/audit\/.*\.rs$/.test(`/${file}`)
  if (name === 'shellcheck') return /^(?:src|test)\//.test(file)
  if (name === 'pyflakes') return /^pyflakes\/(?:checker|messages|api)\.py$|^pyflakes\/test\//.test(file)
  return false
}
