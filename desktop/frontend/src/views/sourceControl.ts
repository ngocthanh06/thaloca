// Source Control view: repository list, changes/history/graph/branches/
// files tabs, and GitHub OAuth + Pull Request review. This is the largest
// and most stateful view (real git mutations: stage/unstage/commit/merge/
// branch-delete, plus an OAuth device-flow with polling), so unlike
// views/overview.ts / views/runtime.ts / views/timeline.ts it owns its
// state internally rather than taking everything via parameters — main.ts
// only feeds it `activity` (via renderSourceView) and calls a small set of
// exported entry points. Button clicks route through main.ts's existing
// document-level delegated click handler, which imports these handlers by
// name; this module does not bind its own document listeners.
import { api } from '../api'
import type {
  ActivitySummary, RepositoryActivity, Commit, RepoBranch, GitHubStatus, GitHubCLIAccount,
  DeviceCode, GraphCommit, PullRequest, PullRequestDetail, PullRequestFilter, PullRequestCounts,
  PullRequestCommit, CheckRun, PullRequestFile, ReviewComment, RepoEntry,
  FileChange, CommitFile, SecurityReport, GitHookStatus,
} from '../api'
import { escapeHTML, formatBytes, formatDate, getSourceBadgeClass, showError } from '../dom'
import { groupFindings, renderFindingGroup, renderScannerStatusRow } from './security'

export const ACTIVITY_REFRESH_EVENT = 'thaloca:activity-refresh'

let currentActivity: ActivitySummary | null = null

// main.ts calls this whenever `activity` changes (initial load, refresh,
// ignore/track/mine-only toggles) — the same data-in pattern as the other
// views, just stashed in a module variable so the ~20 internal renderSource()
// call sites below (unchanged from before the split) don't all need it
// threaded through as a parameter.
export function renderSourceView(activity: ActivitySummary | null): void {
  currentActivity = activity
  ensureVSCodeChecked()
  renderSource()
}

// Detected once per session (cheap — a single exec.LookPath on the Go
// side — but no reason to repeat it on every render) so the "Open in VS
// Code" button can be hidden entirely on machines without it, instead of
// showing an action that would just fail.
let hasVSCode: boolean | null = null
let vsCodeCheckStarted = false
function ensureVSCodeChecked(): void {
  if (vsCodeCheckStarted) return
  vsCodeCheckStarted = true
  void api.hasVSCode().then(result => {
    hasVSCode = result
    renderSource()
  }).catch(() => { hasVSCode = false })
}

export function setSourceFilter(value: string): void {
  sourceRepoFilter = value.trim().toLowerCase()
  renderSource()
}

// Consolidates the "select repo in Source Control" flow used by three
// different entry points (repo list click, "open in Source Control" from
// Overview/Activity, and a Git timeline row click).
export async function openRepoInSourceControl(path: string): Promise<void> {
  selectedRepoPath = path
  const isNew = !repoDetails.has(path)
  if (isNew) repoDetails.set(path, { tab: 'changes', dir: '', loading: false })
  if (isNew) {
    // Fetched once per repo (not per tab visit, unlike GitHubStatus on the
    // PRs tab) since the header shows it regardless of which tab is
    // active — cheap, a local remote-URL read, no network/auth involved.
    void api.repoGitHubOwner(path).then(owner => {
      const detail = repoDetails.get(path)
      if (detail) { detail.githubOwner = owner; renderSource() }
    })
  }
  await loadRepoTab(path, repoDetails.get(path)!.tab)
}

export function togglePinRepo(path: string): void {
  togglePin(path)
}

export type { RepoDetail }

let sourceRepoFilter = ''
interface RepoDetail {
  tab: 'changes' | 'history' | 'graph' | 'branches' | 'files' | 'prs' | 'security'
  graph?: GraphCommit[]
  graphLimit?: number
  stashes?: string[]
  commits?: Commit[]
  historyDone?: boolean
  historyLoadingMore?: boolean
  branches?: RepoBranch[]
  branchFilter?: string
  branchLimit?: number
  dir: string
  entries?: RepoEntry[]
  file?: string
  fileContent?: string
  fileMaximized?: boolean
  gh?: GitHubStatus
  // Org/user that owns this repo's origin remote (from RepoGitHubOwner) —
  // distinct from the repo.identity shown next to it, which is just which
  // local git identity this machine commits here as.
  githubOwner?: string
  prs?: PullRequest[]
  pr?: PullRequestDetail
  prFilter?: PullRequestFilter
  prCounts?: PullRequestCounts
  prAuthors?: string[]
  repoLabels?: string[]
  repoCollaborators?: string[]
  prNewFormOpen?: boolean
  labelEditorOpen?: boolean
  reviewerEditorOpen?: boolean
  assigneeEditorOpen?: boolean
  prDiffView?: 'split' | 'unified'
  // Split/unified preference for the read-only diffs in Changes/History/
  // Graph (separate from prDiffView, which is PR-review-specific and also
  // drives the inline-comment gutter).
  diffView?: 'split' | 'unified'
  // PR detail sub-tabs, mirroring github.com's Conversation/Commits/
  // Checks/Files changed. Each tab's data is fetched lazily on first visit.
  prTab?: 'conversation' | 'commits' | 'checks' | 'files'
  prCommits?: PullRequestCommit[]
  prChecks?: CheckRun[]
  prFiles?: PullRequestFile[]
  prSelectedFile?: string
  prReviewComments?: ReviewComment[]
  // `${filename}:${line}:${side}` of the line whose "write a comment" box is
  // open — at most one at a time.
  prCommentDraftKey?: string
  // First line of a dragged multi-line selection (undefined = single line);
  // prCommentDraftKey's line is always the range's last/bottom line.
  prCommentRangeStart?: number
  changes?: FileChange[]
  diffPath?: string
  diffStaged?: boolean
  diffText?: string
  commitHash?: string
  commitSubject?: string
  commitFiles?: CommitFile[]
  commitFilePath?: string
  commitFileDiff?: string
  // Security tab: gitHookStatus is fetched whenever the tab opens (just two
  // file-existence checks); securityReport only appears after an explicit
  // "Scan now" click, since a real scan (gitleaks/trivy/gosec/semgrep) can
  // take well past what auto-loading a tab should block on.
  gitHookStatus?: GitHookStatus
  securityReport?: SecurityReport
  securityScanning?: boolean
  loading: boolean
  // Bumped by loadRepoTab/refreshPullRequests on every call; a call whose
  // token no longer matches by the time its awaits resolve was superseded
  // by a newer one (e.g. rapid tab switching) and must not overwrite state
  // with its now-stale result.
  loadToken?: number
}
const repoDetails = new Map<string, RepoDetail>()
export async function loadRepoTab(path: string, tab: RepoDetail['tab']) {
  const detail = repoDetails.get(path)
  if (!detail) return
  detail.tab = tab
  detail.loading = true
  const token = (detail.loadToken = (detail.loadToken || 0) + 1)
  const stale = () => detail.loadToken !== token
  renderSource()
  try {
    if (tab === 'changes') {
      // Always re-read: the working tree changes outside the app.
      const changes = (await api.gitChanges(path)) || []
      const stashes = (await api.stashList(path)) || []
      if (stale()) return
      detail.changes = changes
      detail.stashes = stashes
    } else if (tab === 'graph') {
      const graph = (await api.repoGraph(path, detail.graphLimit || 120)) || []
      if (stale()) return
      detail.graph = graph
    } else if (tab === 'history' && !detail.commits) {
      const commits = (await api.repoCommits(path, 100, 0)) || []
      if (stale()) return
      detail.commits = commits
      detail.historyDone = commits.length < 100
    } else if (tab === 'branches') {
      const branches = (await api.repoBranches(path)) || []
      if (stale()) return
      detail.branches = branches
    } else if (tab === 'files' && !detail.entries) {
      const entries = (await api.repoFiles(path, detail.dir)) || []
      if (stale()) return
      detail.entries = entries
    } else if (tab === 'security') {
      const gitHookStatus = await api.getGitHookStatus(path)
      if (stale()) return
      detail.gitHookStatus = gitHookStatus
    } else if (tab === 'prs') {
      const gh = await api.githubStatus(path)
      if (stale()) return
      detail.gh = gh
      if (detail.gh?.authenticated && detail.gh?.repo) {
        if (!detail.prFilter) detail.prFilter = { state: 'open' }
        const filter = detail.prFilter
        // All four independent of each other — fire together instead of
        // four sequential round trips, which is what made the PR tab feel
        // slow to open.
        const [authors, labels, prs, counts] = await Promise.all([
          api.listPullRequestAuthors(path),
          api.listRepositoryLabels(path),
          api.listPullRequests(path, filter),
          api.countPullRequests(path, filter),
        ])
        if (stale()) return
        detail.prAuthors = authors || []
        detail.repoLabels = labels || []
        detail.prs = prs || []
        detail.prCounts = counts
      }
    }
  } catch (error) {
    if (!stale()) showError(String(error))
  }
  if (stale()) return
  detail.loading = false
  renderSource()
}

// Re-fetches the PR list (and, by default, the per-tab counts) for a repo
// with its current filter — used after filter changes and after actions
// that change what should be listed (merge/close/reopen all move a PR out
// of the currently selected state). `skipRender` lets loadRepoTab batch this
// into its own single render at the end instead of rendering twice.
async function refreshPullRequests(path: string, skipRender = false): Promise<void> {
  const detail = repoDetails.get(path)
  if (!detail) return
  const token = (detail.loadToken = (detail.loadToken || 0) + 1)
  try {
    const filter = detail.prFilter || {}
    const [prs, counts] = await Promise.all([
      api.listPullRequests(path, filter),
      api.countPullRequests(path, filter),
    ])
    if (detail.loadToken !== token) return
    detail.prs = prs || []
    detail.prCounts = counts
  } catch (error) {
    if (detail.loadToken === token) showError(String(error))
    return
  }
  if (skipRender) return
  renderSource()
}

// Colorize a unified diff: added/removed/hunk/meta lines get their own class.
function renderDiff(text: string): string {
  return (text || '').split('\n').map(line => {
    let cls = ''
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) cls = ' diff-meta'
    else if (line.startsWith('@@')) cls = ' diff-hunk'
    else if (line.startsWith('+')) cls = ' diff-add'
    else if (line.startsWith('-')) cls = ' diff-del'
    return `<span class="diff-line${cls}">${escapeHTML(line) || ' '}</span>`
  }).join('')
}

export async function handleLoadMore(button: HTMLButtonElement) {
  const repo = button.dataset.repo || ''
  const detail = repoDetails.get(repo)
  if (!repo || !detail) return
  button.disabled = true
  button.textContent = 'Loading…'
  try {
    if (button.dataset.historyMore) {
      const page = (await api.repoCommits(repo, 100, (detail.commits || []).length)) || []
      detail.commits = [...(detail.commits || []), ...page]
      detail.historyDone = page.length < 100
    } else if (button.dataset.graphMore) {
      detail.graphLimit = (detail.graphLimit || 120) + 150
      detail.graph = (await api.repoGraph(repo, detail.graphLimit)) || []
    } else if (button.dataset.branchMore) {
      detail.branchLimit = (detail.branchLimit || 30) + 50
    }
  } catch (error) {
    showError(String(error))
  }
  renderSource()
}

export async function handleCommitAction(button: HTMLButtonElement) {
  const repo = button.dataset.repo || ''
  const detail = repoDetails.get(repo)
  if (!repo || !detail) return
  if (button.dataset.commitBack) {
    detail.commitHash = undefined
    detail.commitFiles = undefined
    detail.commitFilePath = undefined
    detail.commitFileDiff = undefined
    renderSource()
    return
  }
  try {
    if (button.dataset.commitView) {
      // Toggle: clicking the selected commit again closes its panel.
      if (detail.commitHash === button.dataset.commitView) {
        detail.commitHash = undefined
        detail.commitFiles = undefined
        detail.commitFilePath = undefined
        detail.commitFileDiff = undefined
        renderSource()
        return
      }
      detail.commitHash = button.dataset.commitView
      detail.commitSubject = button.dataset.subject || ''
      detail.commitFilePath = undefined
      detail.commitFileDiff = undefined
      detail.loading = true
      renderSource()
      const requestedHash = detail.commitHash
      const files = (await api.commitFiles(repo, requestedHash)) || []
      // A newer commit selection may have started (and finished) while this
      // request was in flight — ignore this now-stale response.
      if (detail.commitHash !== requestedHash) return
      detail.commitFiles = files
      detail.loading = false
      renderSource()
      return
    }
    if (button.dataset.commitFile !== undefined && detail.commitHash) {
      const file = button.dataset.commitFile
      // Clicking the open file again hides its diff.
      if (detail.commitFilePath === file) {
        detail.commitFilePath = undefined
        detail.commitFileDiff = undefined
        renderSource()
        return
      }
      detail.commitFilePath = file
      detail.commitFileDiff = 'Loading diff...'
      renderSource()
      detail.commitFileDiff = String(await api.commitDiff(repo, detail.commitHash, file))
      renderSource()
    }
  } catch (error) {
    detail.loading = false
    showError(String(error))
    renderSource()
  }
}

// Split/Unified toggle shared by the read-only diffs in Changes, History,
// and the Graph side panel (renderDiffToolbar).
export function handleDiffViewToggle(button: HTMLButtonElement): void {
  const repo = button.dataset.repo || ''
  const detail = repoDetails.get(repo)
  if (!repo || !detail || !button.dataset.diffViewToggle) return
  detail.diffView = button.dataset.diffViewToggle as 'split' | 'unified'
  renderSource()
}

export async function handleChangesAction(button: HTMLButtonElement) {
  const repo = button.dataset.repo || ''
  const detail = repoDetails.get(repo)
  if (!repo || !detail) return
  try {
    if (button.dataset.diffFile !== undefined) {
      const file = button.dataset.diffFile
      const staged = button.dataset.staged === '1'
      // Clicking the same file again hides the diff.
      if (detail.diffPath === file && detail.diffStaged === staged) {
        detail.diffPath = undefined
        detail.diffText = undefined
        renderSource()
        return
      }
      detail.diffPath = file
      detail.diffStaged = staged
      detail.diffText = 'Loading diff...'
      renderSource()
      detail.diffText = String(await api.gitDiff(repo, file, staged))
      renderSource()
      return
    }
    if (button.dataset.stage) {
      await api.stageFile(repo, button.dataset.stage)
    } else if (button.dataset.unstage) {
      await api.unstageFile(repo, button.dataset.unstage)
    } else if (button.dataset.resolve) {
      const file = button.dataset.file || ''
      const strategy = button.dataset.resolve
      const label = strategy === 'ours' ? 'your version (ours)' : 'their version (theirs)'
      if (!(await api.confirmDialog('Resolve conflict', `Keep ${label} for "${file}" and mark it resolved?`))) return
      await api.resolveConflict(repo, file, strategy)
    } else if (button.dataset.commit) {
      const input = button.closest('.commit-box')?.querySelector('textarea') as HTMLTextAreaElement | null
      const message = input?.value.trim() || ''
      if (!message) {
        showError('Write a commit message first.')
        return
      }
      if (!(await api.confirmDialog('Commit', 'Commit the staged changes?'))) return
      await api.commitChanges(repo, message)
      detail.commits = undefined // history is stale after a commit
    }
  } catch (error) {
    showError(String(error))
  }
  detail.diffPath = undefined
  detail.diffText = undefined
  await loadRepoTab(repo, 'changes')
}

export async function handleBranchAction(button: HTMLButtonElement) {
  const repo = button.dataset.repo || ''
  const branch = button.dataset.branch || ''
  if (!repo) return
  const detail = repoDetails.get(repo)
  try {
    if (button.dataset.branchCreate) {
      const input = button.closest('.branch-toolbar')?.querySelector('input:not(#branch-filter)') as HTMLInputElement | null
      const name = input?.value.trim() || ''
      if (!name) {
        showError('Enter a branch name first.')
        return
      }
      await api.createBranch(repo, name)
    } else if (button.dataset.branchSwitch) {
      if (!(await api.confirmDialog('Switch branch', `Switch this repository to branch "${branch}"?`))) return
      await api.switchBranch(repo, branch)
      if (detail) detail.commits = undefined
    } else if (button.dataset.branchMerge) {
      if (!(await api.confirmDialog('Merge branch', `Merge "${branch}" into the current branch? On conflicts, the merge stays open so you can resolve them in the Changes tab, then commit to finish it.`))) return
      await api.mergeBranch(repo, branch)
      if (detail) detail.commits = undefined
    } else if (button.dataset.branchDelete) {
      if (!(await api.confirmDialog('Delete branch', `Delete branch "${branch}"? Unmerged branches are protected and will refuse deletion.`))) return
      await api.deleteBranch(repo, branch)
    }
  } catch (error) {
    showError(String(error))
  }
  // Switching/merging changes the sidebar's current-branch label and
  // ahead/behind counts — same refresh handleSyncAction fires after
  // fetch/pull/push, otherwise the sidebar keeps showing the old branch
  // until the next full Refresh.
  document.dispatchEvent(new CustomEvent(ACTIVITY_REFRESH_EVENT))
  await loadRepoTab(repo, 'branches')
}

export async function handleFileAction(button: HTMLButtonElement) {
  const repo = button.dataset.repo || ''
  const detail = repoDetails.get(repo)
  if (!repo || !detail) return
  if (button.dataset.fileClose) {
    detail.file = undefined
    detail.fileContent = undefined
    detail.fileMaximized = false
    renderSource()
    return
  }
  if (button.dataset.fileMaximize) {
    detail.fileMaximized = !detail.fileMaximized
    renderSource()
    return
  }
  if (button.dataset.fileOpen) {
    detail.file = button.dataset.fileOpen
    detail.fileContent = 'Loading...'
    renderSource()
    try {
      detail.fileContent = String(await api.repoFile(repo, detail.file) ?? '')
    } catch (error) {
      detail.fileContent = `Could not read file: ${String(error)}`
    }
    renderSource()
    return
  }
  // Directory navigation (data-file-nav can be "" for the repo root).
  detail.dir = button.dataset.fileNav || ''
  detail.entries = undefined
  detail.file = undefined
  detail.fileContent = undefined
  detail.fileMaximized = false
  await loadRepoTab(repo, 'files')
}

export async function handlePRAction(button: HTMLButtonElement) {
  const repo = button.dataset.repo || ''
  const detail = repoDetails.get(repo)
  if (!repo || !detail) return

  if (button.dataset.prBack) {
    detail.pr = undefined
    renderSource()
    return
  }

  if (button.dataset.prView) {
    detail.loading = true
    detail.prTab = 'conversation'
    detail.prCommits = undefined
    detail.prChecks = undefined
    detail.prFiles = undefined
    detail.prSelectedFile = undefined
    detail.prReviewComments = undefined
    detail.prCommentDraftKey = undefined
    detail.prCommentRangeStart = undefined
    renderSource()
    try {
      detail.pr = await api.pullRequestDetail(repo, Number(button.dataset.prView))
    } catch (error) {
      showError(String(error))
    }
    detail.loading = false
    renderSource()
    return
  }

  if (button.dataset.prStateTab) {
    detail.prFilter = { ...(detail.prFilter || {}), state: button.dataset.prStateTab }
    await refreshPullRequests(repo)
    return
  }

  if (button.dataset.prNewToggle) {
    detail.prNewFormOpen = !detail.prNewFormOpen
    if (detail.prNewFormOpen && !detail.branches) {
      try {
        detail.branches = (await api.repoBranches(repo)) || []
      } catch (error) {
        showError(String(error))
      }
    }
    if (detail.prNewFormOpen && !detail.repoCollaborators) {
      try {
        detail.repoCollaborators = (await api.listRepositoryCollaborators(repo)) || []
      } catch (error) {
        showError(String(error))
      }
    }
    renderSource()
    return
  }

  if (button.dataset.prNewCancel) {
    detail.prNewFormOpen = false
    renderSource()
    return
  }

  if (button.dataset.prNewSubmit) {
    const form = button.closest('.pr-new-form')
    const base = (form?.querySelector('.pr-new-base') as HTMLSelectElement | null)?.value || ''
    const head = (form?.querySelector('.pr-new-head') as HTMLSelectElement | null)?.value || ''
    const title = (form?.querySelector('.pr-new-title') as HTMLInputElement | null)?.value.trim() || ''
    const prBody = (form?.querySelector('.pr-new-body') as HTMLTextAreaElement | null)?.value || ''
    const draft = (form?.querySelector('.pr-new-draft-checkbox') as HTMLInputElement | null)?.checked || false
    const reviewers: string[] = []
    form?.querySelectorAll<HTMLInputElement>('.pr-new-reviewer-checkbox:checked').forEach(cb => reviewers.push(cb.value))
    const assignees: string[] = []
    form?.querySelectorAll<HTMLInputElement>('.pr-new-assignee-checkbox:checked').forEach(cb => assignees.push(cb.value))
    if (!title) {
      showError('Title is required.')
      return
    }
    if (!base || !head || base === head) {
      showError('Pick two different branches.')
      return
    }
    button.disabled = true
    const originalLabel = button.textContent
    try {
      // GitHub requires the head branch to already exist on the remote —
      // push it first (idempotent: a no-op if it's already up to date)
      // instead of surfacing a confusing "Validation Failed" from the PR
      // creation call itself when the branch was never pushed.
      button.textContent = 'Pushing branch…'
      await api.pushBranch(repo, head)
      button.textContent = 'Creating pull request…'
      const pr = await api.createPullRequest(repo, base, head, title, prBody, draft)
      // The PR itself is already created at this point — a reviewer/assignee
      // request failing (e.g. an invalid login) shouldn't be reported as if
      // PR creation failed, so these run best-effort with their own errors.
      if (reviewers.length) {
        try { await api.requestReviewers(repo, pr.number, reviewers) } catch (error) { showError(`PR #${pr.number} created, but requesting reviewers failed: ${error}`) }
      }
      if (assignees.length) {
        try { await api.addAssignees(repo, pr.number, assignees) } catch (error) { showError(`PR #${pr.number} created, but adding assignees failed: ${error}`) }
      }
      detail.prNewFormOpen = false
      // Show the just-created PR immediately instead of waiting on a fresh
      // list+count round trip to GitHub's API — refreshPullRequests still
      // runs right after to reconcile with the server's actual state.
      const filterState = detail.prFilter?.state || 'open'
      if (filterState === 'open' || filterState === 'all') {
        detail.prs = [pr, ...(detail.prs || [])]
        if (detail.prCounts) detail.prCounts.open += 1
      }
      renderSource()
      await refreshPullRequests(repo)
    } catch (error) {
      showError(String(error))
      button.disabled = false
      button.textContent = originalLabel
    }
    return
  }

  if (button.dataset.prMerge) {
    const method = button.dataset.prMerge
    const num = Number(button.dataset.pr || 0)
    if (!num) return
    const methodLabel: Record<string, string> = { merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge' }
    if (!(await api.confirmDialog('Merge pull request', `${methodLabel[method] || 'Merge'} PR #${num}? This cannot be undone.`))) return
    button.disabled = true
    try {
      await api.mergePullRequest(repo, num, method)
      detail.pr = undefined
      await refreshPullRequests(repo)
    } catch (error) {
      showError(String(error))
      button.disabled = false
    }
    return
  }

  if (button.dataset.prClose) {
    const num = Number(button.dataset.pr || 0)
    if (!num || !(await api.confirmDialog('Close pull request', `Close PR #${num} without merging?`))) return
    button.disabled = true
    try {
      await api.closePullRequest(repo, num)
      detail.pr = await api.pullRequestDetail(repo, num)
      await refreshPullRequests(repo)
    } catch (error) {
      showError(String(error))
    }
    button.disabled = false
    return
  }

  if (button.dataset.prReopen) {
    const num = Number(button.dataset.pr || 0)
    if (!num || !(await api.confirmDialog('Reopen pull request', `Reopen PR #${num}?`))) return
    button.disabled = true
    try {
      await api.reopenPullRequest(repo, num)
      detail.pr = await api.pullRequestDetail(repo, num)
      await refreshPullRequests(repo)
    } catch (error) {
      showError(String(error))
    }
    button.disabled = false
    return
  }

  if (button.dataset.prReady) {
    const num = Number(button.dataset.pr || 0)
    if (!num || !(await api.confirmDialog('Mark ready for review', `Take PR #${num} out of draft?`))) return
    button.disabled = true
    try {
      await api.markPullRequestReadyForReview(repo, num)
      detail.pr = await api.pullRequestDetail(repo, num)
    } catch (error) {
      showError(String(error))
    }
    button.disabled = false
    renderSource()
    return
  }

  if (button.dataset.prLabelsToggle) {
    detail.labelEditorOpen = !detail.labelEditorOpen
    if (detail.labelEditorOpen && !detail.repoLabels) {
      try {
        detail.repoLabels = (await api.listRepositoryLabels(repo)) || []
      } catch (error) {
        showError(String(error))
      }
    }
    renderSource()
    return
  }

  if (button.dataset.prLabelsCancel) {
    detail.labelEditorOpen = false
    renderSource()
    return
  }

  if (button.dataset.prLabelsSave) {
    const num = Number(button.dataset.pr || 0)
    if (!num) return
    const editor = button.closest('.pr-label-editor')
    const selected: string[] = []
    editor?.querySelectorAll<HTMLInputElement>('.pr-label-checkbox:checked').forEach(cb => selected.push(cb.value))
    button.disabled = true
    try {
      await api.setPullRequestLabels(repo, num, selected)
      detail.pr = await api.pullRequestDetail(repo, num)
      detail.labelEditorOpen = false
    } catch (error) {
      showError(String(error))
    }
    button.disabled = false
    renderSource()
    return
  }

  if (button.dataset.prReviewersToggle) {
    detail.reviewerEditorOpen = !detail.reviewerEditorOpen
    if (detail.reviewerEditorOpen && !detail.repoCollaborators) {
      try {
        detail.repoCollaborators = (await api.listRepositoryCollaborators(repo)) || []
      } catch (error) {
        showError(String(error))
      }
    }
    renderSource()
    return
  }

  if (button.dataset.prReviewersCancel) {
    detail.reviewerEditorOpen = false
    renderSource()
    return
  }

  if (button.dataset.prReviewersSave) {
    const num = Number(button.dataset.pr || 0)
    if (!num) return
    const editor = button.closest('.pr-reviewer-editor')
    const selected = new Set<string>()
    editor?.querySelectorAll<HTMLInputElement>('.pr-reviewer-checkbox:checked').forEach(cb => selected.add(cb.value))
    const current = new Set(detail.pr?.requested_reviewers || [])
    const toAdd = [...selected].filter(r => !current.has(r))
    const toRemove = [...current].filter(r => !selected.has(r))
    button.disabled = true
    try {
      if (toAdd.length) await api.requestReviewers(repo, num, toAdd)
      if (toRemove.length) await api.removeReviewers(repo, num, toRemove)
      detail.pr = await api.pullRequestDetail(repo, num)
      detail.reviewerEditorOpen = false
    } catch (error) {
      showError(String(error))
    }
    button.disabled = false
    renderSource()
    return
  }

  if (button.dataset.prAssigneesToggle) {
    detail.assigneeEditorOpen = !detail.assigneeEditorOpen
    if (detail.assigneeEditorOpen && !detail.repoCollaborators) {
      try {
        detail.repoCollaborators = (await api.listRepositoryCollaborators(repo)) || []
      } catch (error) {
        showError(String(error))
      }
    }
    renderSource()
    return
  }

  if (button.dataset.prAssigneesCancel) {
    detail.assigneeEditorOpen = false
    renderSource()
    return
  }

  if (button.dataset.prAssigneesSave) {
    const num = Number(button.dataset.pr || 0)
    if (!num) return
    const editor = button.closest('.pr-assignee-editor')
    const selected = new Set<string>()
    editor?.querySelectorAll<HTMLInputElement>('.pr-assignee-checkbox:checked').forEach(cb => selected.add(cb.value))
    const current = new Set(detail.pr?.assignees || [])
    const toAdd = [...selected].filter(a => !current.has(a))
    const toRemove = [...current].filter(a => !selected.has(a))
    button.disabled = true
    try {
      if (toAdd.length) await api.addAssignees(repo, num, toAdd)
      if (toRemove.length) await api.removeAssignees(repo, num, toRemove)
      detail.pr = await api.pullRequestDetail(repo, num)
      detail.assigneeEditorOpen = false
    } catch (error) {
      showError(String(error))
    }
    button.disabled = false
    renderSource()
    return
  }

  if (button.dataset.prDiffView) {
    detail.prDiffView = button.dataset.prDiffView as 'split' | 'unified'
    renderSource()
    return
  }

  if (button.dataset.prDetailTab) {
    const tab = button.dataset.prDetailTab as RepoDetail['prTab']
    detail.prTab = tab
    renderSource()
    if (!detail.pr) return
    const num = detail.pr.number
    try {
      if (tab === 'commits' && !detail.prCommits) {
        detail.prCommits = (await api.pullRequestCommits(repo, num)) || []
      } else if (tab === 'checks' && !detail.prChecks) {
        detail.prChecks = (await api.pullRequestChecks(repo, num)) || []
      } else if (tab === 'files' && !detail.prFiles) {
        const [files, comments] = await Promise.all([
          api.pullRequestFiles(repo, num),
          api.listReviewComments(repo, num),
        ])
        detail.prFiles = files || []
        detail.prReviewComments = comments || []
        detail.prSelectedFile = detail.prFiles[0]?.filename
      }
    } catch (error) {
      showError(String(error))
    }
    renderSource()
    return
  }

  if (button.dataset.prSelectFile) {
    detail.prSelectedFile = button.dataset.prSelectFile
    detail.prCommentDraftKey = undefined
    detail.prCommentRangeStart = undefined
    renderSource()
    return
  }

  if (button.dataset.prCommentAdd) {
    const filename = button.dataset.prFile || ''
    const line = Number(button.dataset.prLine || 0)
    const side = button.dataset.prSide || 'RIGHT'
    detail.prCommentDraftKey = commentKey(filename, line, side)
    detail.prCommentRangeStart = undefined
    renderSource()
    return
  }

  if (button.dataset.prCommentCancel) {
    detail.prCommentDraftKey = undefined
    detail.prCommentRangeStart = undefined
    renderSource()
    return
  }

  if (button.dataset.prCommentSubmit) {
    if (!detail.pr) return
    const filename = button.dataset.prFile || ''
    const line = Number(button.dataset.prLine || 0)
    const side = button.dataset.prSide || 'RIGHT'
    const draft = button.closest('.diff-comment-draft')
    const body = (draft?.querySelector('.diff-comment-draft-input') as HTMLTextAreaElement | null)?.value.trim() || ''
    const startLineInput = Number((draft?.querySelector('.diff-comment-start-line') as HTMLInputElement | null)?.value || line)
    if (!body) {
      showError('Write a comment first.')
      return
    }
    button.disabled = true
    try {
      const startLine = startLineInput !== line ? Math.min(startLineInput, line) : 0
      await api.createReviewComment(repo, detail.pr.number, detail.pr.head_sha, filename, Math.max(startLineInput, line), side, startLine, startLine ? side : '', body)
      detail.prReviewComments = (await api.listReviewComments(repo, detail.pr.number)) || []
      detail.prCommentDraftKey = undefined
      detail.prCommentRangeStart = undefined
    } catch (error) {
      showError(String(error))
    }
    button.disabled = false
    renderSource()
    return
  }

  if (button.dataset.prCommentReply) {
    if (!detail.pr) return
    const commentID = Number(button.dataset.prCommentReply)
    const body = (button.closest('.diff-comment-reply-row')?.querySelector('.diff-reply-input') as HTMLInputElement | null)?.value.trim() || ''
    if (!body) {
      showError('Write a reply first.')
      return
    }
    button.disabled = true
    try {
      await api.replyToReviewComment(repo, detail.pr.number, commentID, body)
      detail.prReviewComments = (await api.listReviewComments(repo, detail.pr.number)) || []
    } catch (error) {
      showError(String(error))
    }
    button.disabled = false
    renderSource()
    return
  }

  const action = button.dataset.prReview || ''
  const prNumber = Number(button.dataset.pr || 0)
  if (!action || !prNumber) return
  const body = (button.closest('.pr-actions')?.querySelector('.pr-comment-input') as HTMLTextAreaElement | null)?.value.trim() || ''
  if (action !== 'approve' && !body) {
    showError('Write a comment first — it is required for this action.')
    return
  }
  const labels: Record<string, string> = {
    approve: `Approve PR #${prNumber}?`,
    'request-changes': `Request changes on PR #${prNumber}?`,
    comment: `Post this comment on PR #${prNumber}?`,
  }
  if (!(await api.confirmDialog('Pull request review', labels[action] || 'Submit review?'))) return
  button.disabled = true
  try {
    await api.reviewPullRequest(repo, prNumber, action, body)
    detail.pr = await api.pullRequestDetail(repo, prNumber)
  } catch (error) {
    showError(String(error))
    button.disabled = false
  }
  renderSource()
}

// Author/Label dropdowns apply immediately on change (state is a click on
// one of the tab buttons, handled in handlePRAction; only free-text search
// needs a debounce, handled by handlePRSearchInput below).
export async function handlePRFilterSelectChange(select: HTMLSelectElement): Promise<void> {
  const repo = select.dataset.repo || ''
  const detail = repoDetails.get(repo)
  if (!repo || !detail) return
  const field = select.id === 'pr-filter-author' ? 'author' : 'label'
  detail.prFilter = { ...(detail.prFilter || {}), [field]: select.value || undefined }
  await refreshPullRequests(repo)
}

let prSearchDebounce: number | null = null

// Free-text search debounces (unlike the author/label dropdowns) since it
// would otherwise re-query GitHub's search API on every keystroke. Focus
// and caret are restored after the delayed re-render, the same way
// handleBranchFilterInput does for its (synchronous, non-debounced) filter.
export function handlePRSearchInput(input: HTMLInputElement): void {
  const repo = input.dataset.repo || ''
  const detail = repoDetails.get(repo)
  if (!repo || !detail) return
  if (prSearchDebounce) window.clearTimeout(prSearchDebounce)
  const caret = input.selectionStart
  prSearchDebounce = window.setTimeout(async () => {
    detail.prFilter = { ...(detail.prFilter || {}), search: input.value.trim() || undefined }
    await refreshPullRequests(repo)
    // The user may have switched repo or tab while this debounce/request was
    // in flight — only steal focus back if the PR search is still current.
    if (selectedRepoPath !== repo || detail.tab !== 'prs') return
    const el = document.getElementById('pr-filter-search') as HTMLInputElement | null
    if (el) {
      el.focus()
      el.setSelectionRange(caret, caret)
    }
  }, 400)
}

// Live branch search: the list re-renders on each keystroke, so focus and
// caret are restored to the input afterwards.
export function handleBranchFilterInput(event: Event) {
  const target = event.target as HTMLInputElement | null
  if (target?.id !== 'branch-filter') return
  const detail = repoDetails.get(target.dataset.repo || '')
  if (!detail) return
  detail.branchFilter = target.value
  detail.branchLimit = 30
  renderSource()
  const el = document.getElementById('branch-filter') as HTMLInputElement | null
  if (el) {
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }
}

function renderRepoDetail(repo: RepositoryActivity): string {
  const detail = repoDetails.get(repo.path)
  if (!detail) return ''
  const path = escapeHTML(repo.path)
  const tabs = `
    <nav class="repo-detail-tabs">
      <button class="subtab ${detail.tab === 'changes' ? 'active' : ''}" data-repo-tab="changes" data-repo="${path}">Changes</button>
      <button class="subtab ${detail.tab === 'history' ? 'active' : ''}" data-repo-tab="history" data-repo="${path}">History</button>
      <button class="subtab ${detail.tab === 'graph' ? 'active' : ''}" data-repo-tab="graph" data-repo="${path}">Graph</button>
      <button class="subtab ${detail.tab === 'branches' ? 'active' : ''}" data-repo-tab="branches" data-repo="${path}">Branches</button>
      <button class="subtab ${detail.tab === 'files' ? 'active' : ''}" data-repo-tab="files" data-repo="${path}">Files</button>
      <button class="subtab ${detail.tab === 'prs' ? 'active' : ''}" data-repo-tab="prs" data-repo="${path}">Pull Requests</button>
      <button class="subtab ${detail.tab === 'security' ? 'active' : ''}" data-repo-tab="security" data-repo="${path}">Security</button>
    </nav>`

  let body = ''
  if (detail.loading) {
    body = '<div class="loading">Loading...</div>'
  } else if (detail.tab === 'changes') {
    body = renderRepoChanges(repo, detail)
  } else if (detail.tab === 'prs') {
    body = renderRepoPRs(repo, detail)
  } else if (detail.tab === 'history') {
    body = renderRepoHistory(repo, detail)
  } else if (detail.tab === 'graph') {
    body = renderRepoGraph(repo, detail)
  } else if (detail.tab === 'security') {
    body = renderRepoSecurity(repo, detail)
  } else if (detail.tab === 'branches') {
    const allBranches = detail.branches || []
    const filter = (detail.branchFilter || '').trim().toLowerCase()
    const filtered = filter ? allBranches.filter(b => b.name.toLowerCase().includes(filter)) : allBranches
    const limit = detail.branchLimit || 30
    const shown = filtered.slice(0, limit)
    body = `
      <div class="branch-toolbar">
        <input id="branch-filter" class="search-input branch-input" type="search" placeholder="Search ${allBranches.length} branches..." value="${escapeHTML(detail.branchFilter || '')}" data-repo="${path}">
        <input class="search-input branch-input" placeholder="new-branch-name">
        <button class="repo-action" data-branch-create="1" data-repo="${path}">Create branch</button>
      </div>
      ${shown.length === 0
        ? `<div class="empty compact">${filter ? 'No branches match the search.' : 'No local branches found.'}</div>`
        : shown.map(branch => `
          <div class="branch-row ${branch.current ? 'current' : ''}">
            <span class="branch-name">${escapeHTML(branch.name)}${branch.current ? ' <em>current</em>' : ''}</span>
            <span class="branch-actions">
              ${branch.current ? '' : `
                <button class="repo-action" data-branch-switch="1" data-repo="${path}" data-branch="${escapeHTML(branch.name)}">Switch</button>
                <button class="repo-action" data-branch-merge="1" data-repo="${path}" data-branch="${escapeHTML(branch.name)}">Merge into current</button>
                <button class="repo-action danger" data-branch-delete="1" data-repo="${path}" data-branch="${escapeHTML(branch.name)}">Delete</button>`}
            </span>
          </div>`).join('')}
      ${filtered.length > limit ? `
        <div class="load-more-row">
          <button class="repo-action" data-branch-more="1" data-repo="${path}">Show more (${shown.length}/${filtered.length})</button>
        </div>` : ''}`
  } else {
    const crumbs = detail.dir ? detail.dir.split('/') : []
    let crumbPath = ''
    body = `
      <div class="file-breadcrumb">
        <button class="crumb" data-file-nav="" data-repo="${path}">${escapeHTML(repo.name)}</button>
        ${crumbs.map(part => {
          crumbPath = crumbPath ? `${crumbPath}/${part}` : part
          return `<span>/</span><button class="crumb" data-file-nav="${escapeHTML(crumbPath)}" data-repo="${path}">${escapeHTML(part)}</button>`
        }).join('')}
      </div>
      ${detail.file !== undefined ? `
        ${detail.fileMaximized ? `<div class="file-view-backdrop" data-file-maximize="1" data-repo="${path}"></div>` : ''}
        <div class="file-view${detail.fileMaximized ? ' maximized' : ''}">
          <header>
            <strong>${escapeHTML(detail.file)}</strong>
            <span class="file-view-header-actions">
              <button class="repo-action" data-file-maximize="1" data-repo="${path}">${detail.fileMaximized ? 'Restore' : 'Maximize'}</button>
              <button class="repo-action" data-file-close="1" data-repo="${path}">Close</button>
            </span>
          </header>
          <pre>${escapeHTML(detail.fileContent ?? '')}</pre>
        </div>` : `
        <div class="file-rows">
          ${(detail.entries || []).length === 0
            ? '<div class="empty compact">Empty directory.</div>'
            : (detail.entries || []).map(entry => {
                const rel = detail.dir ? `${detail.dir}/${entry.name}` : entry.name
                return entry.dir
                  ? `<button class="file-row dir" data-file-nav="${escapeHTML(rel)}" data-repo="${path}"><span>📁</span>${escapeHTML(entry.name)}</button>`
                  : `<button class="file-row" data-file-open="${escapeHTML(rel)}" data-repo="${path}"><span>📄</span>${escapeHTML(entry.name)}<small>${formatBytes(entry.size)}</small></button>`
              }).join('')}
        </div>`}`
  }

  return `<div class="repo-history">${tabs}${body}</div>`
}

// Panel with one commit's files and the selected file's diff. Shared by the
// History tab (full width) and the Graph tab (side panel).
function renderCommitFilesPanel(path: string, detail: RepoDetail): string {
  const files = detail.commitFiles || []
  return `
    <div class="commit-detail">
      <header class="commit-detail-header">
        <button class="repo-action" data-commit-back="1" data-repo="${path}">✕</button>
        <span class="commit-hash">${escapeHTML((detail.commitHash || '').slice(0, 10))}</span>
        <strong>${escapeHTML(detail.commitSubject || '')}</strong>
      </header>
      ${files.length === 0
        ? '<div class="empty compact">No file changes recorded for this commit.</div>'
        : files.map(file => `
          <button class="commit-file ${detail.commitFilePath === file.path ? 'active' : ''}" data-commit-file="${escapeHTML(file.path)}" data-repo="${path}">
            <span class="change-status change-${escapeHTML(file.status)}">${escapeHTML(file.status)}</span>
            <span class="commit-file-path">${escapeHTML(file.path)}</span>
            <span class="commit-file-stats"><em class="add">+${file.additions}</em><em class="del">−${file.deletions}</em></span>
          </button>
          ${detail.commitFilePath === file.path ? `
            <div class="file-view">
              <header><strong>${escapeHTML(file.path)}</strong></header>
              ${renderDiffToolbar(path, detail.diffView || 'split')}
              ${(detail.diffView || 'split') === 'split'
                ? renderPlainSplitDiff(detail.commitFileDiff ?? '')
                : `<pre class="diff">${renderDiff(detail.commitFileDiff ?? '')}</pre>`}
            </div>` : ''}`).join('')}
    </div>`
}

// History: commit list, or one commit's files with per-file diff.
function renderRepoHistory(repo: RepositoryActivity, detail: RepoDetail): string {
  const path = escapeHTML(repo.path)
  if (detail.commitHash) {
    return renderCommitFilesPanel(path, detail)
  }
  const commits = detail.commits || []
  if (commits.length === 0) {
    return '<div class="empty compact">No commits found in this repository.</div>'
  }
  return `
    ${commits.map(commit => `
      <button class="commit grouped commit-clickable" data-commit-view="${escapeHTML(commit.hash)}" data-subject="${escapeHTML(commit.subject)}" data-repo="${path}" title="Show files changed by this commit">
        <span class="commit-hash">${escapeHTML(commit.hash.slice(0, 8))}</span>
        <span class="commit-subject">${escapeHTML(commit.subject)}</span>
        <span class="commit-author" title="${escapeHTML(commit.author_email)}">${escapeHTML(commit.author)}</span>
        <time class="commit-time">${formatDate(commit.occurred_at)}</time>
      </button>`).join('')}
    ${detail.historyDone ? '' : `
      <div class="load-more-row">
        <button class="repo-action" data-history-more="1" data-repo="${path}">Load more (${commits.length} shown)</button>
      </div>`}`
}

// ===== Commit graph (SourceTree-style lanes) =====

const graphColors = ['#55d697', '#60a5fa', '#c084fc', '#ffc966', '#ff6b6b', '#4dd0e1', '#f48fb1', '#aed581']

interface GraphRow {
  lane: number
  color: number
  after: (string | null)[] // hash each lane expects after this row
  afterColor: number[]
}

// Assign a lane to every commit. Lanes hold the hash they are waiting for;
// a commit lands on the leftmost lane waiting for it (merging the others),
// its first parent keeps the lane, extra parents open lanes to the right.
function buildGraphRows(commits: GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = []
  const laneColor: number[] = []
  let colorCounter = 0
  const rows: GraphRow[] = []
  for (const commit of commits) {
    const incoming: number[] = []
    lanes.forEach((hash, i) => { if (hash === commit.hash) incoming.push(i) })
    let lane: number
    if (incoming.length) {
      lane = Math.min(...incoming)
    } else {
      const free = lanes.indexOf(null)
      lane = free === -1 ? lanes.length : free
      if (lane === lanes.length) { lanes.push(null); laneColor.push(0) }
      laneColor[lane] = colorCounter++
    }
    for (const i of incoming) if (i !== lane) lanes[i] = null
    const parents = commit.parents || []
    lanes[lane] = parents[0] ?? null
    for (let p = 1; p < parents.length; p++) {
      if (lanes.indexOf(parents[p]) !== -1) continue // merge into existing lane
      const free = lanes.indexOf(null)
      const target = free === -1 ? lanes.length : free
      if (target === lanes.length) { lanes.push(null); laneColor.push(0) }
      lanes[target] = parents[p]
      laneColor[target] = colorCounter++
    }
    rows.push({ lane, color: laneColor[lane], after: [...lanes], afterColor: [...laneColor] })
  }
  return rows
}

function renderRepoGraph(repo: RepositoryActivity, detail: RepoDetail): string {
  const commits = detail.graph || []
  if (!commits.length) return '<div class="empty compact">No commits to draw.</div>'
  const rows = buildGraphRows(commits)
  const H = 34
  const W = 14
  const maxLanes = rows.reduce((max, row) => Math.max(max, row.after.length, row.lane + 1), 1)
  const width = maxLanes * W + 10
  const x = (lane: number) => lane * W + 8

  let paths = ''
  rows.forEach((row, r) => {
    if (r + 1 >= rows.length) return
    row.after.forEach((hash, j) => {
      if (!hash) return
      const target = commits[r + 1].hash === hash ? rows[r + 1].lane : j
      const x1 = x(j)
      const y1 = r * H + H / 2
      const x2 = x(target)
      const y2 = (r + 1) * H + H / 2
      const color = graphColors[row.afterColor[j] % graphColors.length]
      paths += x1 === x2
        ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2"/>`
        : `<path d="M ${x1} ${y1} C ${x1} ${y1 + H / 2} ${x2} ${y2 - H / 2} ${x2} ${y2}" stroke="${color}" stroke-width="2" fill="none"/>`
    })
  })

  let nodes = ''
  rows.forEach((row, r) => {
    const color = graphColors[row.color % graphColors.length]
    const isMerge = (commits[r].parents || []).length > 1
    nodes += `<circle cx="${x(row.lane)}" cy="${r * H + H / 2}" r="${commits[r].head ? 5 : 3.5}" fill="${isMerge ? 'var(--bg-card)' : color}" stroke="${color}" stroke-width="2"/>`
  })

  const path = escapeHTML(repo.path)
  const rowsHTML = commits.map(commit => {
    const refs = (commit.refs || []).map(ref => {
      const cls = ref.startsWith('tag: ') ? 'tag' : ref.includes('/') ? 'remote' : 'local'
      return `<span class="ref-badge ${cls}">${escapeHTML(ref.replace('tag: ', ''))}</span>`
    }).join('')
    return `
      <button class="graph-row ${detail.commitHash === commit.hash ? 'active' : ''}" style="height:${H}px" data-commit-view="${escapeHTML(commit.hash)}" data-subject="${escapeHTML(commit.subject)}" data-repo="${path}" title="Show files changed by this commit">
        ${refs}
        <span class="graph-subject">${escapeHTML(commit.subject)}</span>
        <span class="commit-author">${escapeHTML(commit.author)}</span>
        <time class="commit-time">${formatDate(commit.occurred_at)}</time>
      </button>`
  }).join('')

  const graphMain = `
    <div class="graph-view">
      <svg class="graph-svg" width="${width}" height="${rows.length * H}">${paths}${nodes}</svg>
      <div class="graph-rows" style="margin-left:${width + 4}px">${rowsHTML}</div>
      ${commits.length >= (detail.graphLimit || 120) ? `
        <div class="load-more-row">
          <button class="repo-action" data-graph-more="1" data-repo="${path}">Load more (${commits.length} shown)</button>
        </div>` : ''}
    </div>`

  // Selected commit opens a side panel; the graph keeps its position.
  if (detail.commitHash) {
    return `<div class="graph-split">${graphMain}<div class="graph-side">${renderCommitFilesPanel(path, detail)}</div></div>`
  }
  return graphMain
}

// Security tab: secrets/vulnerability/static-analysis scanning (see
// internal/security, desktop/security.go) plus pre-commit/pre-push git
// hook install toggles. Runs entirely locally — nothing here uploads
// anything. The hook status is cheap (two file-existence checks) so it's
// fetched whenever the tab opens (loadRepoTab); the scan itself is only
// ever run on an explicit "Scan now" click since gitleaks/trivy/gosec/
// semgrep can take a while.
function renderRepoSecurity(repo: RepositoryActivity, detail: RepoDetail): string {
  const path = escapeHTML(repo.path)
  const hooks = detail.gitHookStatus
  const report = detail.securityReport

  const hookRow = (kind: 'pre-commit' | 'pre-push', installed: boolean) => `
    <div class="security-hook-row">
      <div>
        <strong>${kind === 'pre-commit' ? 'Pre-commit hook' : 'Pre-push hook'}</strong>
        <span class="resource-detail muted">${kind === 'pre-commit' ? 'Scans on every commit — fails on high severity or above.' : 'Scans before every push — fails on critical severity only.'}</span>
      </div>
      <button class="btn-secondary" data-security-hook-toggle="${kind}" data-repo="${path}">${installed ? 'Uninstall' : 'Install'}</button>
    </div>`

  const scanButton = `<button class="btn-primary" data-security-scan="1" data-repo="${path}" ${detail.securityScanning ? 'disabled' : ''}>${detail.securityScanning ? 'Scanning…' : report ? 'Scan again' : 'Scan now'}</button>`

  let resultsHTML: string
  if (detail.securityScanning) {
    resultsHTML = '<div class="empty compact">Running secrets, dependency-vulnerability, and static-analysis scanners — this can take a minute…</div>'
  } else if (!report) {
    resultsHTML = '<div class="empty compact">Not scanned yet this session. Click "Scan now" to check for secrets, known dependency vulnerabilities, and static-analysis issues.</div>'
  } else {
    const statusRow = report.statuses.map(renderScannerStatusRow).join('')
    const findingsHTML = report.findings.length
      ? `<div class="security-findings">${groupFindings(report.findings).map(g => renderFindingGroup(report.path, g)).join('')}</div>`
      : '<div class="empty compact">No findings — looks clean.</div>'
    resultsHTML = `<div class="security-tool-statuses">${statusRow}</div>${findingsHTML}`
  }

  return `
    <div class="security-tab">
      <p class="subview-desc">Runs entirely locally — nothing here leaves this machine. Uses gitleaks/trivy/gosec/semgrep if installed, with a built-in fallback for secret detection.</p>
      <div class="security-hooks">
        ${hookRow('pre-commit', Boolean(hooks?.pre_commit))}
        ${hookRow('pre-push', Boolean(hooks?.pre_push))}
      </div>
      ${scanButton}
      ${resultsHTML}
    </div>`
}

export async function runSecurityScan(path: string): Promise<void> {
  const detail = repoDetails.get(path)
  if (!detail) return
  detail.securityScanning = true
  renderSource()
  try {
    detail.securityReport = await api.runSecurityScan(path)
  } catch (error) {
    showError(String(error))
  }
  detail.securityScanning = false
  renderSource()
}

export async function toggleGitHook(path: string, kind: 'pre-commit' | 'pre-push'): Promise<void> {
  const detail = repoDetails.get(path)
  if (!detail) return
  const installed = kind === 'pre-commit' ? detail.gitHookStatus?.pre_commit : detail.gitHookStatus?.pre_push
  try {
    if (installed) {
      await api.uninstallGitHook(path, kind)
    } else {
      if (!(await api.confirmDialog(
        `Install ${kind} hook`,
        `This writes to .git/hooks/${kind} in this repo, adding a block that runs "thaloca scan" and can block a ${kind === 'pre-commit' ? 'commit' : 'push'} on findings. Any existing hook content is preserved — only Thaloca's own marked block is added/removed. Install it?`,
      ))) return
      await api.installGitHook(path, kind)
    }
    detail.gitHookStatus = await api.getGitHookStatus(path)
  } catch (error) {
    showError(String(error))
  }
  renderSource()
}

const changeStatusLabels: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'untracked', U: 'conflict' }

function renderChangeRow(repo: string, change: FileChange, detail: RepoDetail): string {
  const path = escapeHTML(change.path)
  const label = changeStatusLabels[change.status] || change.status
  const staged = change.staged ? '1' : '0'
  const actions = change.conflict
    ? `<button class="repo-action" data-resolve="ours" data-file="${path}" data-repo="${repo}">Keep ours</button>
       <button class="repo-action" data-resolve="theirs" data-file="${path}" data-repo="${repo}">Keep theirs</button>`
    : change.staged
      ? `<button class="repo-action" data-unstage="${path}" data-repo="${repo}">Unstage</button>`
      : `<button class="repo-action" data-stage="${path}" data-repo="${repo}">Stage</button>`
  // The diff opens right under the clicked file, not at the bottom.
  const diffOpen = detail.diffPath === change.path && detail.diffStaged === change.staged
  return `
    <div class="change-row ${change.conflict ? 'conflict' : ''} ${diffOpen ? 'open' : ''}">
      <span class="change-status change-${escapeHTML(change.status)}" title="${escapeHTML(label)}">${escapeHTML(change.status)}</span>
      <button class="change-path" data-diff-file="${path}" data-staged="${staged}" data-repo="${repo}" title="Show diff">${path}</button>
      <span class="change-actions">${actions}</span>
    </div>
    ${diffOpen ? `
      <div class="file-view">
        <header>
          <strong>${path}${change.staged ? ' (staged)' : ''}</strong>
          <button class="repo-action" data-diff-file="${path}" data-staged="${staged}" data-repo="${repo}">Close</button>
        </header>
        ${renderDiffToolbar(repo, detail.diffView || 'split')}
        ${(detail.diffView || 'split') === 'split'
          ? renderPlainSplitDiff(detail.diffText ?? '')
          : `<pre class="diff">${renderDiff(detail.diffText ?? '')}</pre>`}
      </div>` : ''}`
}

function renderRepoChanges(repo: RepositoryActivity, detail: RepoDetail): string {
  const path = escapeHTML(repo.path)
  const changes = detail.changes || []
  const conflicts = changes.filter(c => c.conflict)
  const staged = changes.filter(c => c.staged)
  const unstaged = changes.filter(c => !c.staged && !c.conflict)

  if (changes.length === 0) {
    return '<div class="empty compact">Working tree is clean — nothing to stage or commit.</div>'
  }

  return `
    ${conflicts.length ? `
      <h4 class="changes-title conflict">Conflicts (${conflicts.length})</h4>
      ${conflicts.map(c => renderChangeRow(path, c, detail)).join('')}` : ''}
    <h4 class="changes-title">Unstaged (${unstaged.length})</h4>
    ${unstaged.length ? unstaged.map(c => renderChangeRow(path, c, detail)).join('') : '<div class="empty compact">Nothing unstaged.</div>'}
    <h4 class="changes-title">Staged (${staged.length})</h4>
    ${staged.length ? staged.map(c => renderChangeRow(path, c, detail)).join('') : '<div class="empty compact">Nothing staged yet.</div>'}
    <div class="commit-box">
      <textarea class="commit-message" placeholder="Commit message..."></textarea>
      <button class="repo-action" data-commit="1" data-repo="${path}" ${staged.length ? '' : 'disabled'}>Commit staged</button>
    </div>`
}

// ========== Source Control view ==========

let selectedRepoPath = ''

// GitHub OAuth device-flow login state
let ghStatus: GitHubStatus | null = null
let ghPanelOpen = false
let ghDevice: DeviceCode | null = null
let ghPollTimer: number | null = null
// True while waiting for `gh auth login` to finish in the Terminal window
// the CLI flow opened — there is no device code to show for this path.
let ghCliWaiting = false
// Every account gh is currently logged into on github.com, for the
// in-app account switcher — only fetched once the active login turns out
// to be via gh (fetching it otherwise would just fail with "not installed"
// or be irrelevant for a Keychain/OAuth login).
let ghCLIAccounts: GitHubCLIAccount[] | null = null
let ghSwitchingAccount = false

function stopGHPolling() {
  if (ghPollTimer) {
    clearInterval(ghPollTimer)
    ghPollTimer = null
  }
  ghDevice = null
  ghCliWaiting = false
}

export async function refreshGHStatus() {
  try {
    ghStatus = await api.githubStatus('')
  } catch {
    ghStatus = null
  }
  if (ghStatus?.authenticated && ghStatus.source === 'gh') {
    try {
      ghCLIAccounts = await api.githubCLIAccounts()
    } catch {
      ghCLIAccounts = null
    }
  } else {
    ghCLIAccounts = null
  }
  renderGHConnect()
}

async function handleGHAccountSwitch(login: string): Promise<void> {
  if (!login || ghSwitchingAccount) return
  ghSwitchingAccount = true
  try {
    await api.switchGitHubCLIAccount(login)
    // `gh auth status` already reports which account is now active, so
    // there's no need for a second, separate network round trip (GET /user
    // via githubStatus) just to re-confirm the same thing — and no need to
    // dispatch ACTIVITY_REFRESH_EVENT either: ahead/behind/branch data is
    // computed from local git state, not the GitHub account, so a full
    // repo rescan here was pure unnecessary latency.
    ghCLIAccounts = await api.githubCLIAccounts()
    const active = ghCLIAccounts?.find(a => a.active)
    if (ghStatus && active) ghStatus = { ...ghStatus, login: active.login }
  } catch (error) {
    showError(String(error))
  }
  ghSwitchingAccount = false
  renderGHConnect()
}

function renderGHConnect() {
  const area = document.getElementById('gh-connect-area')
  if (!area) return
  if (ghStatus?.authenticated) {
    // The gh CLI's active account always wins over Thaloca's own saved
    // login (see resolveGithubToken in desktop/github.go), so "Logout"
    // (which only clears Thaloca's Keychain entry) would silently do
    // nothing while gh stays logged in — switch the active gh account
    // instead, via the picker below.
    const viaGH = ghStatus.source === 'gh'
    if (viaGH) {
      const accounts = ghCLIAccounts || []
      area.innerHTML = `
        <span class="gh-connected" title="Active gh CLI account">✓ ${escapeHTML(ghStatus.login || 'GitHub')} (via gh CLI)</span>
        ${accounts.length > 1 ? `
          <select class="search-input gh-account-switch" ${ghSwitchingAccount ? 'disabled' : ''}>
            ${accounts.map(acc => `<option value="${escapeHTML(acc.login)}" ${acc.active ? 'selected' : ''}>${escapeHTML(acc.login)}</option>`).join('')}
          </select>` : ''}`
      area.querySelector('.gh-account-switch')?.addEventListener('change', event => {
        void handleGHAccountSwitch((event.target as HTMLSelectElement).value)
      })
    } else {
      area.innerHTML = `<span class="gh-connected" title="Logged in via GitHub OAuth">✓ ${escapeHTML(ghStatus.login || 'GitHub')}</span>
         <button class="repo-action" data-gh-logout="1">Logout</button>`
    }
    return
  }
  if (!ghPanelOpen) {
    area.innerHTML = `<button class="repo-action" data-gh-open="1">Connect GitHub</button>`
    return
  }
  if (ghDevice) {
    area.innerHTML = `
      <div class="gh-panel">
        <span>Enter this code in the browser tab that just opened:</span>
        <strong class="gh-code">${escapeHTML(ghDevice.user_code)}</strong>
        <span class="muted">Waiting for authorization…</span>
        <button class="repo-action" data-gh-cancel="1">Cancel</button>
      </div>`
    return
  }
  if (ghCliWaiting) {
    area.innerHTML = `
      <div class="gh-panel">
        <span>Finish "gh auth login" in the Terminal window that just opened.</span>
        <span class="muted">Waiting for it to complete…</span>
        <button class="repo-action" data-gh-cancel="1">Cancel</button>
      </div>`
    return
  }
  // Three ways in: paste a personal access token (fastest), the gh CLI
  // (installs it via Homebrew if missing, then runs `gh auth login`), or the
  // OAuth device flow (needs the app's client id saved once).
  const tokenRow = `
    <span class="gh-row">
      <input class="search-input gh-token-input" type="password" placeholder="Paste a personal access token (repo scope)">
      <button class="repo-action" data-gh-save-token="1">Save token</button>
    </span>`
  const cliRow = `<button class="repo-action" data-gh-cli="1">Connect with gh CLI</button>`
  if (!ghStatus?.configured) {
    area.innerHTML = `
      <div class="gh-panel">
        ${tokenRow}
        ${cliRow}
        <span class="gh-row muted">…or set up OAuth login once: paste the OAuth app <b>client id</b> (GitHub → Settings → Developer settings → OAuth Apps, enable Device Flow).</span>
        <span class="gh-row">
          <input class="search-input gh-client-input" placeholder="OAuth app client id">
          <button class="repo-action" data-gh-save-client="1">Save</button>
          <button class="repo-action" data-gh-cancel="1">Close</button>
        </span>
      </div>`
    return
  }
  area.innerHTML = `
    <div class="gh-panel">
      <button class="repo-action" data-gh-login="1">Login with GitHub</button>
      ${tokenRow}
      ${cliRow}
      <button class="repo-action" data-gh-cancel="1">Close</button>
    </div>`
}

export async function handleGHAction(button: HTMLButtonElement) {
  try {
    if (button.dataset.ghOpen) {
      ghPanelOpen = true
      renderGHConnect()
      return
    }
    if (button.dataset.ghCancel) {
      stopGHPolling()
      ghPanelOpen = false
      renderGHConnect()
      return
    }
    if (button.dataset.ghLogout) {
      if (!(await api.confirmDialog('GitHub logout', 'Remove the stored GitHub login from your Keychain?'))) return
      await api.githubLogout()
      await refreshGHStatus()
      return
    }
    if (button.dataset.ghSaveToken) {
      const input = button.closest('.gh-panel')?.querySelector('.gh-token-input') as HTMLInputElement | null
      const token = input?.value.trim() || ''
      if (!token) {
        showError('Paste a token first.')
        return
      }
      button.disabled = true
      button.textContent = 'Checking…'
      await api.githubSetToken(token)
      stopGHPolling()
      ghPanelOpen = false
      await refreshGHStatus()
      repoDetails.forEach(d => { d.gh = undefined; d.prs = undefined })
      renderSource()
      return
    }
    if (button.dataset.ghSaveClient) {
      const input = button.closest('.gh-panel')?.querySelector('input') as HTMLInputElement | null
      const id = input?.value.trim() || ''
      if (!id) {
        showError('Paste the OAuth app client id first.')
        return
      }
      await api.setGitHubClientID(id)
      await refreshGHStatus()
      ghPanelOpen = true
      renderGHConnect()
      return
    }
    if (button.dataset.ghCli) {
      const installed = await api.githubCLIInstalled()
      const message = installed
        ? 'This will run "gh auth login" in Terminal. Follow the prompts there, then come back and click Refresh.'
        : 'This will run "brew install gh && gh auth login" in Terminal (requires Homebrew). Follow the prompts there, then come back and click Refresh.'
      if (!(await api.confirmDialog('Connect with gh CLI?', message))) return
      await api.connectGitHubCLI()
      ghCliWaiting = true
      renderGHConnect()
      ghPollTimer = window.setInterval(async () => {
        try {
          ghStatus = await api.githubStatus('')
          if (ghStatus?.authenticated) {
            stopGHPolling()
            ghPanelOpen = false
            // A fresh login changes what the PR tab can show.
            repoDetails.forEach(d => { d.gh = undefined; d.prs = undefined })
            renderSource()
          }
        } catch {
          // Transient — keep polling until the user cancels.
        }
      }, 3000)
      return
    }
    if (button.dataset.ghLogin) {
      button.disabled = true
      ghDevice = await api.githubDeviceStart()
      renderGHConnect()
      const interval = Math.max(ghDevice.interval || 5, 5)
      ghPollTimer = window.setInterval(async () => {
        try {
          const status = await api.githubDevicePoll()
          if (status === 'ok') {
            stopGHPolling()
            ghPanelOpen = false
            await refreshGHStatus()
            // A fresh login changes what the PR tab can show.
            repoDetails.forEach(d => { d.gh = undefined; d.prs = undefined })
            renderSource()
          }
        } catch (error) {
          stopGHPolling()
          showError(String(error))
          renderGHConnect()
        }
      }, interval * 1000)
    }
  } catch (error) {
    showError(String(error))
    renderGHConnect()
  }
}

export async function handleSyncAction(button: HTMLButtonElement) {
  const repo = button.dataset.repo || ''
  const action = button.dataset.sync || ''
  if (!repo || !action) return
  const confirms: Record<string, string> = {
    pull: 'Pull (fast-forward only) this repository?',
    push: 'Push the current branch to its remote?',
    stash: 'Stash all local changes (including untracked files)?',
    pop: 'Apply and remove the most recent stash?',
  }
  if (confirms[action] && !(await api.confirmDialog('Git ' + action, confirms[action]))) return
  const original = button.textContent
  button.disabled = true
  button.textContent = action === 'fetch' ? 'Fetching…' : action === 'pull' ? 'Pulling…' : action === 'push' ? 'Pushing…' : 'Working…'
  try {
    if (action === 'fetch') await api.fetchRepo(repo)
    else if (action === 'pull') await api.pullRepo(repo)
    else if (action === 'push') await api.pushRepo(repo)
    else if (action === 'stash') await api.stashSave(repo)
    else if (action === 'pop') await api.stashPop(repo)
  } catch (error) {
    showError(String(error))
  }
  button.textContent = original
  const detail = repoDetails.get(repo)
  if (detail) {
    detail.commits = undefined
    detail.graph = undefined
  }
  // Ahead/behind/changed counts live in `activity`, owned by main.ts —
  // request a refresh via the same custom-event pattern serviceInspector.ts
  // uses, instead of importing loadActivity directly (circular import).
  document.dispatchEvent(new CustomEvent(ACTIVITY_REFRESH_EVENT))
  if (detail) await loadRepoTab(repo, detail.tab)
}

function renderSource() {
  const reposEl = document.getElementById('source-repos')
  const detailEl = document.getElementById('source-detail')
  if (!reposEl || !detailEl || !currentActivity) return
  renderGHConnect()

  const repos = (currentActivity.repositories || [])
    .filter(r => !r.ignored)
    .filter(r => !sourceRepoFilter || `${r.name} ${r.path} ${r.branch || ''}`.toLowerCase().includes(sourceRepoFilter))

  // Pinned repos float to a dedicated group on top; the rest are grouped by
  // parent folder. Inside a group, repos with local changes come first.
  const pinned = repos.filter(r => pinnedRepos.has(r.path))
  const unpinned = repos.filter(r => !pinnedRepos.has(r.path))
  const groups = new Map<string, RepositoryActivity[]>()
  for (const repo of unpinned) {
    const parent = repo.path.split('/').slice(0, -1).pop() || '/'
    const list = groups.get(parent)
    if (list) list.push(repo)
    else groups.set(parent, [repo])
  }
  const orderedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  const renderRepoItem = (repo: RepositoryActivity) => {
    const dirty = (repo.changed_files || 0) + (repo.staged_files || 0)
    const isPinned = pinnedRepos.has(repo.path)
    return `
      <button class="source-repo ${repo.path === selectedRepoPath ? 'active' : ''}" data-source-repo="${escapeHTML(repo.path)}" title="${escapeHTML(repo.path)}">
        <span class="source-repo-line">
          <strong>${escapeHTML(repo.name)}</strong>
          ${dirty ? `<em class="dirty-badge">${dirty}</em>` : ''}
          <span class="pin-btn ${isPinned ? 'pinned' : ''}" data-pin-repo="${escapeHTML(repo.path)}" title="${isPinned ? 'Unpin' : 'Pin to top'}">${isPinned ? '★' : '☆'}</span>
        </span>
        <small>${escapeHTML(repo.branch || '')}${repo.ahead ? ` · ↑${repo.ahead}` : ''}${repo.behind ? ` · ↓${repo.behind}` : ''}</small>
      </button>`
  }

  const sortDirtyFirst = (list: RepositoryActivity[]) => [...list].sort((a, b) => {
    const dirtyA = (a.changed_files || 0) + (a.staged_files || 0) > 0 ? 0 : 1
    const dirtyB = (b.changed_files || 0) + (b.staged_files || 0) > 0 ? 0 : 1
    return dirtyA !== dirtyB ? dirtyA - dirtyB : a.name.localeCompare(b.name)
  })

  reposEl.innerHTML = repos.length
    ? `${pinned.length ? `<div class="source-group-label">📌 Pinned</div>${sortDirtyFirst(pinned).map(renderRepoItem).join('')}` : ''}
       ${orderedGroups.map(([parent, list]) =>
         `<div class="source-group-label">${escapeHTML(parent)}</div>${sortDirtyFirst(list).map(renderRepoItem).join('')}`).join('')}`
    : `<div class="empty compact">${sourceRepoFilter ? 'No repositories match the filter.' : 'No repositories discovered yet.'}</div>`

  const repo = repos.find(r => r.path === selectedRepoPath)
  if (!repo) {
    detailEl.innerHTML = '<div class="empty">Select a repository on the left to see its changes, history, graph, branches, files, and pull requests.</div>'
    return
  }
  const path = escapeHTML(repo.path)
  const repoDetail = repoDetails.get(repo.path)
  const stashes = repoDetail?.stashes || []
  detailEl.innerHTML = `
    <div class="sync-toolbar">
      <div class="sync-repo">
        <strong>${escapeHTML(repo.name)}</strong>
        <small>${escapeHTML(repo.branch || '')}${repo.ahead ? ` · ↑${repo.ahead}` : ''}${repo.behind ? ` · ↓${repo.behind}` : ''}${repo.identity ? ` · Committing as ${escapeHTML(repo.identity)}` : ''}${repoDetail?.githubOwner ? ` · GitHub: ${escapeHTML(repoDetail.githubOwner)}` : ''}</small>
      </div>
      <span class="sync-actions">
        <button class="repo-action" data-open-folder="${path}" title="Open folder in Finder">Open Folder</button>
        ${hasVSCode ? `<button class="repo-action" data-open-vscode="${path}" title="Open in VS Code">VS Code</button>` : ''}
        <button class="repo-action" data-sync="fetch" data-repo="${path}">Fetch</button>
        <button class="repo-action" data-sync="pull" data-repo="${path}">Pull${repo.behind ? ` (${repo.behind})` : ''}</button>
        <button class="repo-action" data-sync="push" data-repo="${path}">Push${repo.ahead ? ` (${repo.ahead})` : ''}</button>
        <button class="repo-action" data-sync="stash" data-repo="${path}">Stash</button>
        ${stashes.length ? `<button class="repo-action" data-sync="pop" data-repo="${path}">Pop (${stashes.length})</button>` : ''}
      </span>
    </div>
    ${renderRepoDetail(repo)}`
}

function renderRepoPRs(repo: RepositoryActivity, detail: RepoDetail): string {
  const path = escapeHTML(repo.path)
  const gh = detail.gh
  if (!gh || !gh.authenticated || !gh.repo) {
    return `<div class="gh-setup">
      <strong>GitHub is not connected for this repository.</strong>
      <p>${escapeHTML(gh?.message || 'Use the Connect GitHub button above to sign in.')}</p>
    </div>`
  }

  if (detail.pr) {
    return renderPRDetail(detail.pr, repo.path, detail)
  }

  return `
    ${renderPRToolbar(repo.path, detail)}
    ${detail.prNewFormOpen ? renderPRNewForm(repo.path, detail) : ''}
    ${renderPRList(detail, gh.repo, repo.path)}`
}

// State tabs mirror github.com's own Open/Closed(/Merged) tabs above the PR
// list — each tab's count reflects the current author/label/search filter,
// just like github.com's tab counts do.
function renderPRToolbar(path: string, detail: RepoDetail): string {
  const filter = detail.prFilter || {}
  const state = filter.state || 'open'
  const counts = detail.prCounts || { open: 0, closed: 0, merged: 0 }
  const escapedPath = escapeHTML(path)
  const tabs: { value: string; label: string }[] = [
    { value: 'open', label: `Open ${counts.open}` },
    { value: 'closed', label: `Closed ${counts.closed}` },
    { value: 'merged', label: `Merged ${counts.merged}` },
    { value: 'all', label: 'All' },
  ]
  const authors = detail.prAuthors || []
  const labels = detail.repoLabels || []
  return `
    <div class="pr-toolbar">
      <div class="pr-state-tabs">
        ${tabs.map(tab => `<button class="pr-state-tab ${state === tab.value ? 'active' : ''}" data-pr-state-tab="${tab.value}" data-repo="${escapedPath}">${escapeHTML(tab.label)}</button>`).join('')}
      </div>
      <div class="pr-filter-row">
        <select id="pr-filter-author" class="search-input pr-filter-select" data-repo="${escapedPath}">
          <option value="">Author: All</option>
          ${authors.map(a => `<option value="${escapeHTML(a)}" ${filter.author === a ? 'selected' : ''}>${escapeHTML(a)}</option>`).join('')}
        </select>
        <select id="pr-filter-label" class="search-input pr-filter-select" data-repo="${escapedPath}">
          <option value="">Label: All</option>
          ${labels.map(l => `<option value="${escapeHTML(l)}" ${filter.label === l ? 'selected' : ''}>${escapeHTML(l)}</option>`).join('')}
        </select>
        <input id="pr-filter-search" class="search-input pr-filter-input" placeholder="Search title or #number..." value="${escapeHTML(filter.search || '')}" data-repo="${escapedPath}">
        <button class="repo-action" data-pr-new-toggle="1" data-repo="${escapedPath}">${detail.prNewFormOpen ? 'Cancel' : 'New pull request'}</button>
      </div>
    </div>`
}

function branchOptionList(branches: RepoBranch[] | undefined, selected: string): string {
  const names = (branches || []).map(b => b.name)
  if (selected && !names.includes(selected)) names.unshift(selected)
  return names.map(name => `<option value="${escapeHTML(name)}" ${name === selected ? 'selected' : ''}>${escapeHTML(name)}</option>`).join('')
}

// Shared by the reviewer/assignee pickers on both the "New pull request"
// form and an existing PR's editors — GitHub only allows requesting review
// from or assigning a repo collaborator, so the picker is always this same
// checkbox-over-collaborators shape, just with a different `selected` set.
function renderCollaboratorCheckboxes(className: string, collaborators: string[], selected: Set<string>): string {
  if (!collaborators.length) return '<span class="muted">No collaborators found for this repository.</span>'
  return collaborators.map(c => `
    <label class="pr-label-option">
      <input type="checkbox" class="${className}" value="${escapeHTML(c)}" ${selected.has(c) ? 'checked' : ''}>
      ${escapeHTML(c)}
    </label>`).join('')
}

function renderPRNewForm(path: string, detail: RepoDetail): string {
  const escapedPath = escapeHTML(path)
  const branches = detail.branches || []
  const collaborators = detail.repoCollaborators || []
  const current = branches.find(b => b.current)?.name || ''
  const defaultBase = branches.find(b => b.name === 'main' || b.name === 'master')?.name || (branches[0]?.name || '')
  return `
    <div class="pr-new-form">
      ${branches.length === 0 ? '<span class="muted">Loading branches…</span>' : `
        <div class="pr-new-row">
          <select class="search-input pr-new-base">${branchOptionList(branches, defaultBase)}</select>
          <span>←</span>
          <select class="search-input pr-new-head">${branchOptionList(branches, current)}</select>
        </div>`}
      <input class="search-input pr-new-title" placeholder="Title">
      <textarea class="pr-comment-input pr-new-body" placeholder="Description (optional)"></textarea>
      <label class="pr-new-draft"><input type="checkbox" class="pr-new-draft-checkbox"> Create as draft</label>
      <div class="pr-new-people">
        <div class="pr-people-group">
          <span class="muted">Reviewers</span>
          ${renderCollaboratorCheckboxes('pr-new-reviewer-checkbox', collaborators, new Set())}
        </div>
        <div class="pr-people-group">
          <span class="muted">Assignees</span>
          ${renderCollaboratorCheckboxes('pr-new-assignee-checkbox', collaborators, new Set())}
        </div>
      </div>
      <div class="pr-action-buttons">
        <button class="repo-action" data-pr-new-cancel="1" data-repo="${escapedPath}">Cancel</button>
        <button class="repo-action" data-pr-new-submit="1" data-repo="${escapedPath}">Create pull request</button>
      </div>
    </div>`
}

function prStateBadge(state: string): string {
  const cls = (state || 'open').toLowerCase()
  return `<span class="pr-state ${escapeHTML(cls)}">${escapeHTML(cls)}</span>`
}

function renderPRList(detail: RepoDetail, repoSlug: string, path: string): string {
  const prs = detail.prs || []
  if (prs.length === 0) {
    return `<div class="empty compact">No pull requests match the current filter in ${escapeHTML(repoSlug)}.</div>`
  }
  return prs.map(pr => `
    <button class="pr-row" data-pr-view="${pr.number}" data-repo="${escapeHTML(path)}">
      <span class="pr-number">#${pr.number}</span>
      <span class="pr-title">
        ${escapeHTML(pr.title)}${pr.is_draft ? ' <em>draft</em>' : ''}
        ${(pr.labels || []).map(l => `<span class="pr-label">${escapeHTML(l)}</span>`).join('')}
      </span>
      <span class="pr-meta">${escapeHTML(pr.author)} · ${escapeHTML(pr.head_ref)} → ${escapeHTML(pr.base_ref)}</span>
      ${prStateBadge(pr.state)}
      ${pr.review_decision ? `<span class="pr-decision ${escapeHTML(pr.review_decision.toLowerCase())}">${escapeHTML(pr.review_decision.replaceAll('_', ' ').toLowerCase())}</span>` : '<span></span>'}
    </button>`).join('')
}

function renderLabelEditor(pr: PullRequestDetail, detail: RepoDetail, path: string): string {
  const escapedPath = escapeHTML(path)
  const labels = detail.repoLabels
  if (!labels) return `<div class="pr-label-editor"><span class="muted">Loading labels…</span></div>`
  if (labels.length === 0) return `<div class="pr-label-editor"><span class="muted">This repository has no labels defined on GitHub.</span></div>`
  const current = new Set(pr.labels || [])
  return `
    <div class="pr-label-editor">
      ${labels.map(l => `
        <label class="pr-label-option">
          <input type="checkbox" class="pr-label-checkbox" value="${escapeHTML(l)}" ${current.has(l) ? 'checked' : ''}>
          ${escapeHTML(l)}
        </label>`).join('')}
      <div class="pr-action-buttons">
        <button class="repo-action" data-pr-labels-cancel="1" data-repo="${escapedPath}">Cancel</button>
        <button class="repo-action" data-pr-labels-save="1" data-pr="${pr.number}" data-repo="${escapedPath}">Save labels</button>
      </div>
    </div>`
}

function renderReviewerEditor(pr: PullRequestDetail, detail: RepoDetail, path: string): string {
  const escapedPath = escapeHTML(path)
  const collaborators = detail.repoCollaborators
  if (!collaborators) return `<div class="pr-reviewer-editor"><span class="muted">Loading collaborators…</span></div>`
  const current = new Set(pr.requested_reviewers || [])
  return `
    <div class="pr-reviewer-editor">
      ${renderCollaboratorCheckboxes('pr-reviewer-checkbox', collaborators, current)}
      <div class="pr-action-buttons">
        <button class="repo-action" data-pr-reviewers-cancel="1" data-repo="${escapedPath}">Cancel</button>
        <button class="repo-action" data-pr-reviewers-save="1" data-pr="${pr.number}" data-repo="${escapedPath}">Save reviewers</button>
      </div>
    </div>`
}

function renderAssigneeEditor(pr: PullRequestDetail, detail: RepoDetail, path: string): string {
  const escapedPath = escapeHTML(path)
  const collaborators = detail.repoCollaborators
  if (!collaborators) return `<div class="pr-assignee-editor"><span class="muted">Loading collaborators…</span></div>`
  const current = new Set(pr.assignees || [])
  return `
    <div class="pr-assignee-editor">
      ${renderCollaboratorCheckboxes('pr-assignee-checkbox', collaborators, current)}
      <div class="pr-action-buttons">
        <button class="repo-action" data-pr-assignees-cancel="1" data-repo="${escapedPath}">Cancel</button>
        <button class="repo-action" data-pr-assignees-save="1" data-pr="${pr.number}" data-repo="${escapedPath}">Save assignees</button>
      </div>
    </div>`
}

// PR detail is a shell (header + Conversation/Commits/Checks/Files changed
// tabs, matching github.com's own PR page) around whichever tab body is
// currently active; each tab's data loads lazily on first visit (see
// handlePRDetailTab).
function renderPRDetail(pr: PullRequestDetail, path: string, detail: RepoDetail): string {
  const escapedPath = escapeHTML(path)
  const state = (pr.state || 'OPEN').toUpperCase()
  const tab = detail.prTab || 'conversation'
  const tabs: { value: RepoDetail['prTab']; label: string }[] = [
    { value: 'conversation', label: 'Conversation' },
    { value: 'commits', label: `Commits${detail.prCommits ? ` ${detail.prCommits.length}` : ''}` },
    { value: 'checks', label: 'Checks' },
    { value: 'files', label: `Files changed${detail.prFiles ? ` ${detail.prFiles.length}` : ''}` },
  ]
  return `
    <div class="pr-detail">
      <header class="pr-detail-header">
        <button class="repo-action" data-pr-back="1" data-repo="${escapedPath}">← Back</button>
        <strong>#${pr.number} ${escapeHTML(pr.title)}</strong>
        ${prStateBadge(state)}
        <small>by ${escapeHTML(pr.author)}</small>
      </header>
      <div class="pr-detail-tabs">
        ${tabs.map(t => `<button class="pr-detail-tab ${tab === t.value ? 'active' : ''}" data-pr-detail-tab="${t.value}" data-repo="${escapedPath}">${escapeHTML(t.label)}</button>`).join('')}
      </div>
      ${tab === 'conversation' ? renderPRConversationTab(pr, path, detail) : ''}
      ${tab === 'commits' ? renderPRCommitsTab(detail) : ''}
      ${tab === 'checks' ? renderPRChecksTab(detail) : ''}
      ${tab === 'files' ? renderPRFilesTab(path, detail) : ''}
    </div>`
}

function renderPRConversationTab(pr: PullRequestDetail, path: string, detail: RepoDetail): string {
  const escapedPath = escapeHTML(path)
  const state = (pr.state || 'OPEN').toUpperCase()
  return `
      ${pr.body ? `<pre class="pr-body">${escapeHTML(pr.body)}</pre>` : ''}
      <div class="pr-labels-row">
        ${(pr.labels || []).map(l => `<span class="pr-label">${escapeHTML(l)}</span>`).join('') || '<span class="muted">No labels</span>'}
        <button class="repo-action" data-pr-labels-toggle="1" data-repo="${escapedPath}">Edit labels</button>
      </div>
      ${detail.labelEditorOpen ? renderLabelEditor(pr, detail, path) : ''}
      <div class="pr-reviewers-row">
        <span class="muted">Reviewers: ${(pr.requested_reviewers || []).map(r => escapeHTML(r)).join(', ') || 'none requested'}</span>
        <button class="repo-action" data-pr-reviewers-toggle="1" data-repo="${escapedPath}">Edit reviewers</button>
      </div>
      ${detail.reviewerEditorOpen ? renderReviewerEditor(pr, detail, path) : ''}
      <div class="pr-assignees-row">
        <span class="muted">Assignees: ${(pr.assignees || []).map(a => escapeHTML(a)).join(', ') || 'none'}</span>
        <button class="repo-action" data-pr-assignees-toggle="1" data-repo="${escapedPath}">Edit assignees</button>
      </div>
      ${detail.assigneeEditorOpen ? renderAssigneeEditor(pr, detail, path) : ''}
      ${(pr.comments || []).length ? `
        <div class="pr-comments">
          ${(pr.comments || []).map(comment => `
            <div class="pr-comment">
              <span class="pr-comment-meta"><b>${escapeHTML(comment.author)}</b> · ${formatDate(comment.created_at)}</span>
              <p>${escapeHTML(comment.body)}</p>
            </div>`).join('')}
        </div>` : ''}
      <div class="pr-actions">
        <textarea class="pr-comment-input" placeholder="Write a review comment..."></textarea>
        <div class="pr-action-buttons">
          <button class="repo-action" data-pr-review="comment" data-pr="${pr.number}" data-repo="${escapedPath}">Comment</button>
          <button class="repo-action" data-pr-review="approve" data-pr="${pr.number}" data-repo="${escapedPath}">Approve</button>
          <button class="repo-action danger" data-pr-review="request-changes" data-pr="${pr.number}" data-repo="${escapedPath}">Request changes</button>
        </div>
        <div class="pr-action-buttons">
          ${pr.is_draft ? `<button class="repo-action" data-pr-ready="1" data-pr="${pr.number}" data-repo="${escapedPath}">Ready for review</button>` : ''}
          ${state === 'OPEN' ? `
            <button class="repo-action" data-pr-merge="merge" data-pr="${pr.number}" data-repo="${escapedPath}">Merge</button>
            <button class="repo-action" data-pr-merge="squash" data-pr="${pr.number}" data-repo="${escapedPath}">Squash and merge</button>
            <button class="repo-action" data-pr-merge="rebase" data-pr="${pr.number}" data-repo="${escapedPath}">Rebase and merge</button>
            <button class="repo-action danger" data-pr-close="1" data-pr="${pr.number}" data-repo="${escapedPath}">Close</button>` : ''}
          ${state === 'CLOSED' ? `<button class="repo-action" data-pr-reopen="1" data-pr="${pr.number}" data-repo="${escapedPath}">Reopen</button>` : ''}
        </div>
      </div>`
}

function renderPRCommitsTab(detail: RepoDetail): string {
  const commits = detail.prCommits
  if (!commits) return `<div class="empty compact">Loading commits…</div>`
  if (commits.length === 0) return `<div class="empty compact">No commits found.</div>`
  return `
    <div class="pr-commit-list">
      ${commits.map(c => `
        <div class="pr-commit-row">
          <code class="pr-commit-sha">${escapeHTML(c.sha.slice(0, 7))}</code>
          <span class="pr-commit-message">${escapeHTML(c.message.split('\n')[0])}</span>
          <span class="pr-commit-meta">${escapeHTML(c.author)} · ${escapeHTML(formatDate(c.date))}</span>
        </div>`).join('')}
    </div>`
}

function checkBadgeClass(check: CheckRun): string {
  if (check.status !== 'completed') return 'pending'
  switch (check.conclusion) {
    case 'success': return 'healthy'
    case 'failure': case 'timed_out': return 'critical'
    case 'cancelled': case 'action_required': return 'warning'
    default: return 'unknown'
  }
}

function checkStatusLabel(check: CheckRun): string {
  if (check.status !== 'completed') return check.status.replace('_', ' ')
  return check.conclusion || 'completed'
}

function renderPRChecksTab(detail: RepoDetail): string {
  const checks = detail.prChecks
  if (!checks) return `<div class="empty compact">Loading checks…</div>`
  if (checks.length === 0) return `<div class="empty compact">No CI checks reported for this pull request.</div>`
  return `
    <div class="pr-checks-list">
      ${checks.map(c => `
        <div class="pr-check-row">
          <span class="status-dot status-${escapeHTML(checkBadgeClass(c))}"></span>
          <span class="pr-check-name">${escapeHTML(c.name)}</span>
          <span class="status-badge status-${escapeHTML(checkBadgeClass(c))}">${escapeHTML(checkStatusLabel(c))}</span>
          ${c.url ? `<button class="repo-action" data-open-external="${escapeHTML(c.url)}">Details</button>` : ''}
        </div>`).join('')}
    </div>`
}

function fileStatusLetter(status: string): string {
  switch (status) {
    case 'added': return 'A'
    case 'removed': return 'D'
    case 'renamed': return 'R'
    default: return 'M'
  }
}

function shortFileName(filename: string): string {
  const parts = filename.split('/')
  return parts[parts.length - 1]
}

function renderPRFilesTab(path: string, detail: RepoDetail): string {
  const files = detail.prFiles
  if (!files) return `<div class="empty compact">Loading changed files…</div>`
  if (files.length === 0) return `<div class="empty compact">No files changed.</div>`
  const escapedPath = escapeHTML(path)
  const selected = detail.prSelectedFile || files[0].filename
  const file = files.find(f => f.filename === selected) || files[0]
  const diffView = detail.prDiffView || 'split'
  const comments = (detail.prReviewComments || []).filter(c => c.path === file.filename)
  return `
    <div class="pr-files-tab">
      <aside class="pr-files-sidebar">
        ${files.map(f => `
          <button class="pr-file-row ${f.filename === file.filename ? 'active' : ''}" data-pr-select-file="${escapeHTML(f.filename)}" data-repo="${escapedPath}">
            <span class="pr-file-status status-${escapeHTML(f.status)}">${fileStatusLetter(f.status)}</span>
            <span class="pr-file-name" title="${escapeHTML(f.filename)}">${escapeHTML(shortFileName(f.filename))}</span>
            <span class="pr-file-stats"><span class="pr-file-add">+${f.additions}</span> <span class="pr-file-del">-${f.deletions}</span></span>
          </button>`).join('')}
      </aside>
      <div class="pr-file-diff-pane">
        <div class="pr-diff-toolbar">
          <span class="pr-file-path" title="${escapeHTML(file.filename)}">${escapeHTML(file.filename)}</span>
          <button class="repo-action ${diffView === 'split' ? 'active' : ''}" data-pr-diff-view="split" data-repo="${escapedPath}">Split</button>
          <button class="repo-action ${diffView === 'unified' ? 'active' : ''}" data-pr-diff-view="unified" data-repo="${escapedPath}">Unified</button>
        </div>
        ${renderFileDiffWithComments(file, comments, diffView, path, detail.prCommentDraftKey, detail.prCommentRangeStart)}
      </div>
    </div>`
}

// --- Split (side-by-side) diff rendering ---
// A best-effort approximation of GitHub's split view: unified diff hunks are
// walked once, pairing up consecutive removed/added line runs greedily
// (no real old/new line matching — that would need a proper diff algorithm
// over file contents, which the API does not give us here).
interface SplitDiffCell { num: number; text: string; cls: 'ctx' | 'add' | 'del' }
interface SplitDiffRow { hunk?: string; left?: SplitDiffCell; right?: SplitDiffCell }
interface SplitDiffFile { header: string; rows: SplitDiffRow[] }

function fileNameFromDiffHeader(header: string): string {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header)
  if (!match) return header.replace(/^diff --git\s*/, '')
  return match[1] === match[2] ? match[1] : `${match[1]} → ${match[2]}`
}

function parseDiffToFiles(text: string): SplitDiffFile[] {
  const files: SplitDiffFile[] = []
  let current: SplitDiffFile | null = null
  let leftNum = 0
  let rightNum = 0
  let pendingDel: string[] = []
  let pendingAdd: string[] = []

  // Only pair del/add lines side by side when their counts match — that is
  // the common "modified these lines" case, and pairing by position is a
  // reasonable approximation of it. When the counts differ, the block is
  // not a clean line-for-line replace (e.g. one deleted line followed by
  // several unrelated added lines), so pairing by position would put
  // unrelated lines next to each other; show all removals first, then all
  // additions instead, same as GitHub does for these blocks.
  const flushPending = () => {
    if (!current) return
    if (pendingDel.length === pendingAdd.length) {
      for (let i = 0; i < pendingDel.length; i++) {
        current.rows.push({
          left: { num: leftNum++, text: pendingDel[i], cls: 'del' },
          right: { num: rightNum++, text: pendingAdd[i], cls: 'add' },
        })
      }
    } else {
      for (const del of pendingDel) {
        current.rows.push({ left: { num: leftNum++, text: del, cls: 'del' } })
      }
      for (const add of pendingAdd) {
        current.rows.push({ right: { num: rightNum++, text: add, cls: 'add' } })
      }
    }
    pendingDel = []
    pendingAdd = []
  }

  for (const line of (text || '').split('\n')) {
    if (line.startsWith('diff --git') || line.startsWith('diff ')) {
      flushPending()
      if (current) files.push(current)
      current = { header: line, rows: [] }
      continue
    }
    if (!current) current = { header: '', rows: [] }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      continue
    }
    if (line.startsWith('@@')) {
      flushPending()
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      leftNum = match ? parseInt(match[1], 10) : 0
      rightNum = match ? parseInt(match[2], 10) : 0
      current.rows.push({ hunk: line })
      continue
    }
    if (line.startsWith('-')) {
      pendingDel.push(line.slice(1))
      continue
    }
    if (line.startsWith('+')) {
      pendingAdd.push(line.slice(1))
      continue
    }
    flushPending()
    const text2 = line.startsWith(' ') ? line.slice(1) : line
    current.rows.push({
      left: { num: leftNum++, text: text2, cls: 'ctx' },
      right: { num: rightNum++, text: text2, cls: 'ctx' },
    })
  }
  flushPending()
  if (current) files.push(current)
  return files
}

// Read-only split view for Changes/History/Graph diffs — same layout and
// alignment fix as the PR Files-changed split view, minus the inline
// comment gutter (there is no PR to attach a review comment to here).
function renderPlainSplitDiffCell(cell: SplitDiffCell | undefined): string {
  if (!cell) return `<span class="diff-split-cell diff-cell-empty"></span>`
  return `<span class="diff-split-cell ${cell.cls}"><span class="diff-split-num">${cell.num}</span><span class="diff-split-text">${escapeHTML(cell.text) || ' '}</span></span>`
}

function renderPlainSplitDiff(text: string): string {
  const files = parseDiffToFiles(text)
  if (files.length === 0) return `<div class="empty compact">No diff available.</div>`
  return files.map(file => `
    <div class="diff-file">
      ${file.header ? `<div class="diff-file-header">${escapeHTML(fileNameFromDiffHeader(file.header))}</div>` : ''}
      <div class="diff-split">
        ${file.rows.map(row => row.hunk
          ? `<div class="diff-split-hunk">${escapeHTML(row.hunk)}</div>`
          : `${renderPlainSplitDiffCell(row.left)}${renderPlainSplitDiffCell(row.right)}`).join('')}
      </div>
    </div>`).join('')
}

// `path` is expected already-HTML-escaped, matching both call sites
// (renderCommitFilesPanel/renderChangeRow, which escape repo.path once
// up front rather than per-use).
function renderDiffToolbar(path: string, view: 'split' | 'unified'): string {
  return `
    <div class="pr-diff-toolbar">
      <button class="repo-action ${view === 'split' ? 'active' : ''}" data-diff-view-toggle="split" data-repo="${path}">Split</button>
      <button class="repo-action ${view === 'unified' ? 'active' : ''}" data-diff-view-toggle="unified" data-repo="${path}">Unified</button>
    </div>`
}

// --- Files changed: per-file diff with inline (single/multi-line) review
// comments — github.com's "Files changed" tab. Only the split view supports
// adding new comments (the "+" gutter button needs a single side/line to
// anchor to); the unified view still shows existing comment threads, just
// without the add-comment affordance, since a unified line does not
// unambiguously map to one side.
function commentKey(path: string, line: number, side: string): string {
  return `${path}:${line}:${side}`
}

// Click-drag over the line-number gutter to select a multi-line comment
// range, the same gesture github.com's own diff view uses. Live highlight
// while dragging is done by toggling a class directly (no re-render, so
// dragging stays smooth); the range is only committed to state — opening
// the actual comment box — on mouseup.
interface DiffDragState { path: string; file: string; side: string; anchor: number; current: number }
let diffDragState: DiffDragState | null = null

function diffGutterCells(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.diff-split-cell[data-diff-gutter]'))
}

function updateDiffDragHighlight(): void {
  const state = diffDragState
  const start = state ? Math.min(state.anchor, state.current) : 0
  const end = state ? Math.max(state.anchor, state.current) : 0
  for (const cell of diffGutterCells()) {
    if (!state) {
      cell.classList.remove('dragging')
      continue
    }
    const match = cell.dataset.diffFile === state.file && cell.dataset.diffSide === state.side
    const line = Number(cell.dataset.diffLine || 0)
    cell.classList.toggle('dragging', match && line >= start && line <= end)
  }
}

// Registered once from main.ts. Kept as document-level mousedown/move/up
// listeners (rather than per-cell) since diff content is re-rendered often
// (tab switches, new comments, filter changes) and delegated listeners
// don't need to be re-attached after that.
export function initDiffCommentDrag(): void {
  document.addEventListener('mousedown', event => {
    const target = event.target as HTMLElement
    if (target.closest('.diff-comment-add')) return
    const cell = target.closest<HTMLElement>('.diff-split-cell[data-diff-gutter]')
    if (!cell) return
    const path = cell.dataset.diffRepo || ''
    const file = cell.dataset.diffFile || ''
    const side = cell.dataset.diffSide || ''
    const line = Number(cell.dataset.diffLine || 0)
    if (!path || !file || !line) return
    diffDragState = { path, file, side, anchor: line, current: line }
    updateDiffDragHighlight()
    event.preventDefault()
  })

  document.addEventListener('mousemove', event => {
    if (!diffDragState) return
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.diff-split-cell[data-diff-gutter]')
    if (!cell || cell.dataset.diffFile !== diffDragState.file || cell.dataset.diffSide !== diffDragState.side) return
    diffDragState.current = Number(cell.dataset.diffLine || diffDragState.current)
    updateDiffDragHighlight()
  })

  document.addEventListener('mouseup', () => {
    if (!diffDragState) return
    const { path, file, side, anchor, current } = diffDragState
    diffDragState = null
    updateDiffDragHighlight()
    const detail = repoDetails.get(path)
    if (!detail) return
    const start = Math.min(anchor, current)
    const end = Math.max(anchor, current)
    detail.prCommentDraftKey = commentKey(file, end, side)
    detail.prCommentRangeStart = start !== end ? start : undefined
    renderSource()
  })
}

function renderCommentThread(comments: ReviewComment[], path: string, filename: string, line: number, side: string, draftOpen: boolean, rangeStart?: number): string {
  const escapedPath = escapeHTML(path)
  const roots = comments.filter(c => !c.in_reply_to)
  const repliesOf = (id: number) => comments.filter(c => c.in_reply_to === id)
  if (roots.length === 0 && !draftOpen) return ''
  return `
    <div class="diff-comment-thread">
      ${roots.map(c => `
        <div class="diff-comment">
          <span class="pr-comment-meta"><b>${escapeHTML(c.author)}</b> · ${formatDate(c.created_at)}</span>
          <p>${escapeHTML(c.body)}</p>
          ${repliesOf(c.id).map(r => `
            <div class="diff-comment diff-comment-reply">
              <span class="pr-comment-meta"><b>${escapeHTML(r.author)}</b> · ${formatDate(r.created_at)}</span>
              <p>${escapeHTML(r.body)}</p>
            </div>`).join('')}
          <div class="diff-comment-reply-row">
            <input class="search-input diff-reply-input" placeholder="Reply...">
            <button class="repo-action" data-pr-comment-reply="${c.id}" data-repo="${escapedPath}">Reply</button>
          </div>
        </div>`).join('')}
      ${draftOpen ? `
        <div class="diff-comment-draft">
          <div class="diff-comment-range-row">
            <label>From line <input type="number" class="diff-comment-start-line" value="${rangeStart || line}" min="1"></label>
            <span class="muted">to line ${line} (${side === 'LEFT' ? 'old version' : 'new version'}) — drag over the line numbers to select a range</span>
          </div>
          <textarea class="pr-comment-input diff-comment-draft-input" placeholder="Write a comment..."></textarea>
          <div class="pr-action-buttons">
            <button class="repo-action" data-pr-comment-cancel="1" data-repo="${escapedPath}">Cancel</button>
            <button class="repo-action" data-pr-comment-submit="1" data-pr-file="${escapeHTML(filename)}" data-pr-line="${line}" data-pr-side="${side}" data-repo="${escapedPath}">Comment</button>
          </div>
        </div>` : ''}
    </div>`
}

function renderFileDiffCell(cell: SplitDiffCell | undefined, filename: string, side: 'LEFT' | 'RIGHT', path: string): string {
  if (!cell) return `<span class="diff-split-cell diff-cell-empty"></span>`
  const addButton = `<button class="diff-comment-add" data-pr-comment-add="1" data-pr-file="${escapeHTML(filename)}" data-pr-line="${cell.num}" data-pr-side="${side}" data-repo="${escapeHTML(path)}" title="Add comment">+</button>`
  // data-diff-gutter etc. let initDiffCommentDrag() turn a click-drag over
  // several lines' numbers into a multi-line comment, the same gesture
  // github.com's own diff view uses.
  return `<span class="diff-split-cell ${cell.cls}" data-diff-gutter="1" data-diff-repo="${escapeHTML(path)}" data-diff-file="${escapeHTML(filename)}" data-diff-side="${side}" data-diff-line="${cell.num}">${addButton}<span class="diff-split-num">${cell.num}</span><span class="diff-split-text">${escapeHTML(cell.text) || ' '}</span></span>`
}

interface UnifiedDiffLine { num: number; side: 'LEFT' | 'RIGHT'; text: string; cls: 'ctx' | 'add' | 'del' }

// Unrolls the split-view's paired rows into the flat line-per-row shape a
// unified diff needs: a context line (identical on both sides) shows once,
// tagged RIGHT so a click on it comments against the new version by
// default; anything else shows its del line (if any) then its add line (if
// any) as separate lines, same as a real unified diff never merges an
// addition and a deletion onto one line.
function toUnifiedLines(rows: SplitDiffRow[]): (UnifiedDiffLine | { hunk: string })[] {
  const lines: (UnifiedDiffLine | { hunk: string })[] = []
  for (const row of rows) {
    if (row.hunk) {
      lines.push({ hunk: row.hunk })
      continue
    }
    if (row.left && row.right && row.left.cls === 'ctx' && row.right.cls === 'ctx') {
      lines.push({ num: row.right.num, side: 'RIGHT', text: row.right.text, cls: 'ctx' })
      continue
    }
    if (row.left) lines.push({ num: row.left.num, side: 'LEFT', text: row.left.text, cls: 'del' })
    if (row.right) lines.push({ num: row.right.num, side: 'RIGHT', text: row.right.text, cls: 'add' })
  }
  return lines
}

function renderFileDiffWithComments(file: PullRequestFile, comments: ReviewComment[], view: 'split' | 'unified', path: string, draftKey: string | undefined, rangeStart: number | undefined): string {
  if (!file.patch) return `<div class="empty compact">No diff available for this file — it may be binary or too large to display.</div>`
  const rows = parseDiffToFiles(file.patch)[0]?.rows || []
  const commentsByLine = new Map<string, ReviewComment[]>()
  for (const c of comments) {
    const key = `${c.line}:${c.side}`
    const list = commentsByLine.get(key) || []
    list.push(c)
    commentsByLine.set(key, list)
  }

  if (view === 'unified') {
    return `<div class="diff-unified">${toUnifiedLines(rows).map(line => {
      if ('hunk' in line) return `<div class="diff-split-hunk">${escapeHTML(line.hunk)}</div>`
      const key = commentKey(file.filename, line.num, line.side)
      const lineComments = commentsByLine.get(`${line.num}:${line.side}`) || []
      const draftOpen = draftKey === key
      return `
        <div class="unified-line-row">${renderFileDiffCell({ num: line.num, text: line.text, cls: line.cls }, file.filename, line.side, path)}</div>
        ${renderCommentThread(lineComments, path, file.filename, line.num, line.side, draftOpen, draftOpen ? rangeStart : undefined)}`
    }).join('')}</div>`
  }

  return `<div class="diff-split">${rows.map(row => {
    if (row.hunk) return `<div class="diff-split-hunk">${escapeHTML(row.hunk)}</div>`
    const leftKey = row.left ? commentKey(file.filename, row.left.num, 'LEFT') : ''
    const rightKey = row.right ? commentKey(file.filename, row.right.num, 'RIGHT') : ''
    const leftComments = row.left ? commentsByLine.get(`${row.left.num}:LEFT`) || [] : []
    const rightComments = row.right ? commentsByLine.get(`${row.right.num}:RIGHT`) || [] : []
    const leftDraft = row.left ? draftKey === leftKey : false
    const rightDraft = row.right ? draftKey === rightKey : false
    return `
      ${renderFileDiffCell(row.left, file.filename, 'LEFT', path)}
      ${renderFileDiffCell(row.right, file.filename, 'RIGHT', path)}
      ${row.left ? renderCommentThread(leftComments, path, file.filename, row.left.num, 'LEFT', leftDraft, leftDraft ? rangeStart : undefined) : ''}
      ${row.right ? renderCommentThread(rightComments, path, file.filename, row.right.num, 'RIGHT', rightDraft, rightDraft ? rangeStart : undefined) : ''}`
  }).join('')}</div>`
}


// Pinned repositories float to the top of the Source Control sidebar.
const pinnedRepos = new Set<string>(JSON.parse(localStorage.getItem('thaloca-pinned') || '[]'))

function togglePin(path: string) {
  if (pinnedRepos.has(path)) pinnedRepos.delete(path)
  else pinnedRepos.add(path)
  localStorage.setItem('thaloca-pinned', JSON.stringify([...pinnedRepos]))
  renderSource()
}

// Exposed for config export/import (backup.go) — pinning lives in
// localStorage, not a Go-side file, so the backend needs it handed in/out.
export function getPinnedRepos(): string[] {
  return [...pinnedRepos]
}

export function setPinnedRepos(repos: string[]): void {
  pinnedRepos.clear()
  for (const r of repos) pinnedRepos.add(r)
  localStorage.setItem('thaloca-pinned', JSON.stringify([...pinnedRepos]))
  renderSource()
}
