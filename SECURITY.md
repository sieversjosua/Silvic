# Security

Please report security issues privately to the repository owner rather than opening
a public issue.

Silvic is intentionally a local developer tool and is not sandboxed at the macOS
application level. Its Electron renderer is sandboxed and isolated from Node; local
filesystem, process, Git, and Harness access is restricted to the main process and a
small validated IPC surface.

Do not include access tokens, deploy keys, private keys, or repository secrets in
bug reports. Silvic should delegate authentication to provider CLIs and must not
store provider credentials.
