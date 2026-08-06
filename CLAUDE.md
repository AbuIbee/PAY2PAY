# PAY2PAY Project Instructions

This is an independent greenfield project.

Authorized project root:

C:\Users\solod\Desktop\PAY2PAY

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

## Absolute filesystem restriction

Claude may only access paths underneath:

C:\Users\solod\Desktop\PAY2PAY

Claude must not read, inspect, list, stat, search, compare, modify, or reference files outside that directory, even for diagnostics, dependency investigation, Git checks, package-manager warnings, environment discovery, or security verification.

If a command, warning, dependency, tool, or package manager references a path outside PAY2PAY:

1. Do not access that path.
2. Do not request permission to access it.
3. Record the warning in docs/OPEN_ISSUES.md.
4. Continue using only PAY2PAY-local information.
5. Stop if the phase cannot be completed without crossing the project boundary.
