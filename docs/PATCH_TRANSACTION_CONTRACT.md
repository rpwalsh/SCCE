# SCCE Workspace Patch Transaction Contract

SCCE accepts filesystem mutations only as a versioned plan of `create`,
`replace`, and `delete` operations. There is no append operation: append has an
ambiguous base and must instead be expressed as a full replacement with the
exact immutable base-content hash. Patch content is a complete UTF-8 string,
and the target's parent directory must already exist.

## Integrity boundary

The kernel contract canonicalizes operations by workspace-relative path,
derives SHA-256 after-content hashes, rejects duplicate or unsafe paths, freezes
the resulting plan, and binds the complete canonical payload to `planHash`.
The Node adapter verifies that hash before filesystem access.

For each target, the adapter:

1. resolves a canonical workspace root and checks containment;
2. refuses symbolic links in the existing path or parent chain;
3. refuses replacement or deletion of existing test/assertion files;
4. stages new bytes in the target directory and verifies their hash;
5. exposes the staged view to an optional in-process targeted validator;
6. repeats the base hash and path checks immediately before commit;
7. performs an exclusive hard-link create, atomic rename replace, or atomic
   rename delete; and
8. verifies the committed state and returns immutable, deterministic mutation
   and transaction receipts.

The base transaction adapter invokes no command or model. Its validation hook
is an in-process callback over a read-only staged view. A failing validator
commits no files.

## Server and IDE boundary

`POST /api/workspace/patch` accepts only
`yopp.workspace-patch-request.v1`: the exact latest persisted workspace ID, a
verified `yopp.patch-transaction-plan.v1`, and the registered validation-policy
ID. A request cannot supply a filesystem root, executable, argument vector, or
environment. The server derives and canonicalizes the stored root, enforces
`runtime.allowedRoots`, and requires the existing two-phase capability approval
over `{ workspaceId, planHash, validationPolicyId, validationBinding }`. The
server computes `validationBinding` from the complete policy and the selected
provider's stable configuration identity; request data cannot supply it.

The default server policy is `trusted-host-pnpm-validate.v1`. It is available
only when `config.policy.allowMutation` is explicitly enabled. It copies the
workspace into a private bounded staging directory, applies the staged plan there, and spawns the
server-owned executable and argument vector directly with `shell:false`. The
policy first performs a frozen, offline, script-disabled dependency materialization
and then runs the repository's root `validate` script. It
limits time, captured output, file count, and byte count; rejects symbolic links
and unsafe working directories; records exit/signal/output hashes; and always
attempts stage cleanup. Only successful staged validation reaches the
compare-and-swap commit boundary. The staging directory is not an operating-
system sandbox: repository validation code can access host resources available
to the server process. The policy name intentionally exposes that limitation;
use the optional isolated provider for code that is not trusted with that host
authority.

### Optional Docker isolation

The server can select `runtime.patchValidation.provider="docker"` at startup.
This is server-owned configuration; the patch request cannot select or modify
the provider, image, executable, network, resource limits, dependency inputs,
or command arguments. The default remains `trusted-host`.
Docker mode registers only `docker-pnpm-validate.v1`; trusted-host mode registers
only `trusted-host-pnpm-validate.v1`. The distinct ID is included in the
approval tuple and receipt. The approval binding covers the exact command policy,
provider, digest-pinned image, resource bounds, and materialization configuration;
the receipt evidence hash additionally binds the observed backend and results.

The Docker provider requires Docker Engine, a pre-pulled image addressed by its
full `sha256` digest, and an exact `packageManager` value in the root
`package.json`. The configured dependency input list must contain only the
lockfile, root/workspace package manifests, workspace declaration, and local
archives referenced by the lockfile. The provider copies those inputs to a
private stage and runs:

```text
corepack pnpm install --frozen-lockfile --ignore-scripts
```

Source files are copied only after that command succeeds and after a recursive
regular-file/symlink/bounds check. The container workspace is a size-limited
tmpfs rather than a host bind mount, so dependency output is subject to a hard
memory-backed capacity before the post-install file/byte checks run. The
host-side source snapshot has a separate bounded in-memory ceiling (256 MiB by
default and at most 1 GiB), which is enforced before Docker is contacted and is
recorded with the observed snapshot byte count in validation evidence. The
materialization network is disconnected and inspected before source is copied.
Validation then runs with no non-`none` Docker network, a read-only container
root, dropped capabilities, `no-new-privileges`, fixed CPU/memory/PID/tmpfs
limits, and a numeric non-root user. Docker is invoked with `shell:false`;
container names, CID files, operating-system temporary stages, and stopped
containers are cleaned on success, failure, timeout, and output overflow.

Minimal opt-in shape:

```json
{
  "runtime": {
    "patchValidation": {
      "provider": "docker",
      "docker": {
        "image": "registry.example/scce-validator@sha256:<64 lowercase hex characters>",
        "materializationNetwork": "bridge",
        "maxHostSnapshotBytes": 268435456,
        "rootPackagePath": "package.json",
        "lockfilePath": "pnpm-lock.yaml",
        "dependencyInputPaths": [
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "packages/kernel/package.json"
        ]
      }
    }
  }
}
```

`SCCE_PATCH_VALIDATION_DOCKER_IMAGE` may provide the digest-pinned image instead
of the `image` field. It does not enable Docker by itself. Dependency
materialization may use the configured `bridge` network to retrieve
integrity-checked lockfile artifacts; source validation is always networkless.
Evidence records the Docker server version, configured digest, resolved image
ID, container ID, resource limits, daemon security options, materialization
network, host snapshot bound and observed size, and inspected validation network
state. `os-sandbox-executed` records that this container path ran. It is not an
attestation of the Docker daemon, host kernel, rootless mode, image supply chain,
or operator configuration. Those remain deployment trust boundaries, and the
record is not independent review evidence.

The VS Code command accepts a selected UTF-8 JSON plan of at most 8 MiB,
independently verifies its content and plan hashes, displays the operation
paths and before/after hashes, requires a modal review, completes the server's
separate capability authorization, retries the exact request once, and checks
that the receipt matches the reviewed workspace, policy, and plan. Patch-plan
generation remains a separate unsatisfied contract; existing Markdown reports
and virtual repair patches are not treated as filesystem-authorized plans.

## Transaction scope

Portable Node filesystem APIs do not provide a filesystem-wide multi-file
transaction. The receipt therefore names the honest scope
`atomic-per-file-with-verified-transaction-rollback`: each target-path change is
atomic, while a failure after earlier changes triggers verified reverse-order
rollback of those changes. The adapter reports rollback failure distinctly and
does not claim that observers can never see an intermediate state across two
different paths.

The containment checks prevent ordinary traversal and link escapes. They do not
claim protection from an adversarial process that can replace a checked parent
directory in the final operating-system race window; a future stronger boundary
would require platform-specific directory-handle (`openat`-style) operations.

Successful receipt hashes exclude time and temporary filenames, so identical
plans, staged evidence, and mutations produce identical receipts. Temporary
stage and rollback files use unpredictable names. Cleanup is attempted after
commit or rollback; an operating-system cleanup refusal can leave a hidden
temporary artifact, but cannot change the receipt or committed target hashes.

## Current verification status

The kernel plan/receipt contract, Node filesystem adapter, staged validation
adapter, server request/authorization boundary, and VS Code parsing/review path
are implemented and covered by targeted tests. The server's non-mutating planning
boundary verifies the latest durable workspace revision, reads bounded exact current
bytes, and converts a strict structured full-file proposal into a content-addressed
plan. The extension and server can apply that reviewed plan when mutation is enabled.
`POST /api/workspace/patch/plan/request` is strict and non-mutating, but no successful
production coding family is demonstrated. A generic existing-module request fails
closed with `422` because its generated ProgramGraph lacks verified repair lineage.
The exported kernel conversion primitive operates only on a trusted internal hydrated
full-file ProgramGraph with exact-base repair lineage, current live absence
observations, and a linked candidate test. It cannot authenticate caller-supplied
lineage or evidence metadata, prove semantic correctness, or claim test execution.
`regressionProtection` remains `0` without execution evidence.

Normal unit tests verify provider selection, invocation construction, bounds,
failure behavior, and the distinction between trusted-host and OS-sandbox
evidence without requiring Docker. A live test runs only when
`SCCE_DOCKER_LIVE=1` and `SCCE_DOCKER_IMAGE` names an available digest-pinned
image. A local live test with the pinned Node 20 image completed the networkless
validation path and emitted the corresponding execution record. That smoke result is
local evidence about this path only; it is not an attestation, production-safety
finding, or independently controlled public review.
