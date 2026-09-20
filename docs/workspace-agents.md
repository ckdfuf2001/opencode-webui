# Workspace layout

This workspace contains multiple independent repositories as top-level
directories. The CWD is the workspace root.

All file paths MUST be workspace-relative and repo-prefixed:
  repoA/src/index.ts   (correct)
  src/index.ts         (WRONG — ambiguous across repositories)
  C:\Users\...\repoA\src\index.ts  (WRONG — never use absolute paths)

When using glob/grep, always scope the pattern to the session's repo
directory. An unscoped search scans every repository and wastes context.
