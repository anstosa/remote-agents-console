---
status: accepted
date: 2026-10-04
---

# A Review tour posts to the pull request as a draft review

A Review tour collects the operator's feedback: inline comments on diff lines, a note per step, and general notes. Until now the only place it could go was a prompt to the Worktree's agent. When the branch is someone else's, or the feedback is meant for the team, it belongs on the branch's **Pull request** on GitHub. GitHub ties a comment to a file, a commit and a line number, so a comment written against the tour's lines must land on the same code in GitHub's diff, or it misleads the reader.

We chose to post an All PR tour's feedback to one Pull request, which the operator picks, as their **Draft review** (GitHub's PENDING review). The operator finishes it on GitHub.

## Considered options

- **Submit the review from the console.** That is one click fewer, but it would publish under the operator's name text they have not seen as GitHub renders it, and it would choose Comment, Approve or Request changes for them. A draft can be read, edited and submitted, or discarded, on GitHub.
- **Post comments one at a time through the REST API.** Each comment would notify and appear at once. A draft keeps everything private until the operator submits it.
- **Place every comment by line number and trust it.** This is cheaper, but a comment written against a dirty working tree, an unpushed commit, or a different merge base would land on the wrong line without any sign that it had.
- **Drop a comment that cannot be placed.** The operator's words would be lost. Posting it on the file with the commented rows quoted keeps it, and makes the location visible.

## Decisions

- **The console only ever creates or adds to a draft.** It opens a review with no `event`, so the review stays pending, or adds to the operator's existing draft. It never submits, approves or requests changes.
- **The operator pins the Pull request.** The request names its number. The server requires it to be open, from the Worktree's branch, and from `origin`'s owner.
- **Placement preconditions.** A post is refused, with a code the client explains, unless all of the following hold:
  - The tour's Comparison fingerprint is still current.
  - Every commented file in the working tree equals HEAD: nothing staged, unstaged or untracked.
  - Local HEAD is the Pull request's head commit.
  - Any existing draft sits on that same commit. Threads attach to the draft's commit, so a draft on an older commit must be submitted or discarded first.
- **Each comment is checked against GitHub's own diff.** The commented rows must exist in GitHub's patch for the file, on the same side and at the same line numbers, within one hunk, with the same text as the tour's rows. A comment that passes is posted as a line thread. One that fails is posted as a file-level thread whose text names the lines and quotes the rows. GitHub may still refuse a line range the server accepted; that comment is posted again as a file-level thread in the same request. A comment is reported failed only when its file is not in the Pull request, or its file-level thread fails as well.
- **Posting is idempotent through hidden markers.** Each thread ends with `<!-- rac:<comment id> -->`. Each note section is appended to the review body with `<!-- rac-section:<key>:<digest of its text> -->`, so a changed section is appended again under a new marker. Before posting, the server reads the draft and skips anything whose marker is already there. Mutations are never retried. After a response whose outcome is unknown (a timeout, a gateway error, or a request-wide GraphQL error), the server reads the draft back and reports what the markers show. A retry therefore posts only what is missing, and posts at one time for the same checkout are serialized.
- **The token needs review write access.** Pull request lookup was read-only. Posting needs `RAC_GITHUB_TOKEN`, or the gh CLI's active `github.com` token, to be allowed to write pull request reviews. A refused token or missing permission is reported as `github_forbidden`, which is not retryable.

## Consequences

- **Kept Findings are posted under the operator's name with no attribution.** This extends ADR 0010's triage decision: a kept Finding is the operator's own comment, and a draft review carries it exactly like one the operator wrote. Untriaged Findings are never posted.
- **Unpushed or uncommitted work blocks a post.** The operator commits and pushes first. This is deliberate: line numbers must name content GitHub has.
- **A file-level thread is a weaker anchor.** GitHub shows it at the top of the file, not on the line. The quoted rows and the location label carry the position instead.
- **The markers are visible in the review's raw Markdown** and in API responses, though GitHub does not render them. Editing a thread or the body on GitHub can remove a marker, after which a retry would post that item again.

*Amended by ADR 0020 (2026-11-04):* Since my review tours post too, under the same rules, and can add replies to the operator's earlier Review threads to the Draft review. Replies carry a third marker kind, `<!-- rac-reply:<thread id>:<digest of its text> -->`.
