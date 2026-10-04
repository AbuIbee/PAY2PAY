# PAY2PAY Project Instructions

This is an independent greenfield project.

The canonical product specification is:

docs/PAY2PAY_MASTER_SPEC.md

The master specification is the source of truth.

For every task:

1. Read the complete master specification before planning or coding.
2. Do not omit, weaken, replace, or contradict its requirements.
3. Work only on the phase explicitly requested.
4. Do not attempt all 15 deliverables or the entire application in one response.
5. Preserve unresolved matters as open decisions.
6. Update the project documentation after each phase.
7. Stop at the end of the requested phase.
8. Never access or reference files outside the PAY2PAY directory.

## Filesystem / Git Worktree Boundary

Claude is authorized to operate only inside the Git worktree in which the current Claude session was started.

Before modifying files, Claude must verify:

    Get-Location
    git rev-parse --show-toplevel
    git branch --show-current

The path returned by:

    git rev-parse --show-toplevel

is the only authorized filesystem root for that session.

Claude must not read, inspect, list, stat, search, compare, modify, copy, delete, or otherwise access files outside that Git worktree root.

Sibling Git worktrees are separate project boundaries and are forbidden from the current session.

Examples of sibling worktrees may include:

    C:\Development\PAY2PAY
    C:\Development\PAY2PAY-bank-v3
    C:\Development\PAY2PAY-b0d-integration
    C:\Development\PAY2PAY-enhancement-sprint

The existence of a sibling worktree does not authorize access to it.

If a task requires another worktree, Claude must STOP and require the user to start a separate Claude session from that worktree.

Claude must never infer authorization from:
- a sibling directory name
- another branch
- another worktree
- historical absolute paths
- prior session context

If the current worktree root cannot be verified, Claude must STOP before making changes.
