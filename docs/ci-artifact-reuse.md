# CI JAR reuse for automatic deployment

The automatic `workflow_run` path deploys the JAR already produced by the
successful main-push CI. CI still runs JDK 21 and the complete existing command:

```sh
./mvnw clean verify --batch-mode --no-transfer-progress
```

Maven's `verify` lifecycle includes packaging. The checked-in POM has no separate
production build profile, and the deployment command did not supply a different
build profile or build-time credentials. Production configuration remains on
EC2 and is applied when the service starts.

## Source and artifact checks

Only a successful `push` to this repository's default `main` branch can publish
an automatic-deployment bundle. The bundle contains one versioned JAR and a
small manifest recording the repository identity, CI workflow path, run ID,
run attempt, exact commit, JAR filename, size and SHA-256. Its artifact name
includes the run and attempt. It is retained for one day.

Successful pull-request CI retains the existing `ec-site-jar` artifact containing
`target/*.jar` for one day. It is review evidence and is never selected by automatic
deployment. Main-push CI now publishes only `ec-site-jar-<run-id>-<run-attempt>`,
replacing the previous fixed `ec-site-jar` name on that path. No checked-in workflow
consumes the old main artifact name; external or manual consumers have not been
ruled out. Both paths upload the JAR produced by the same existing Maven command,
without another build.

Automatic deployment checks the GitHub event and fresh API records for the
repository, default branch, CI workflow, successful run and current attempt.
It checks out the producer's exact commit and selects exactly one artifact ID
from that run. Pull-request, fork, different-workflow, different-repository,
failed-run, old-attempt and different-commit evidence is rejected.

The pinned download action receives the repository, run ID and artifact ID
explicitly. Its `digest-mismatch: error` setting rejects an archive digest
mismatch. The local verifier also requires the expected manifest and one regular
JAR file, rejects extra entries and symlinks, and checks the actual JAR size and
SHA-256 before staging it at the existing deployment filename. These are
provider metadata and checksum checks; they are not a signature or an artifact
attestation.

No missing, expired, ambiguous or mismatched artifact causes a silent rebuild
or selection of another successful run. The automatic path fails before SCP.

## A newer main commit

The previous deployment checkout used the default branch, so it could build a
newer main commit than the one whose CI had succeeded. Exact artifact reuse
must not replace that drift with deployment of an older commit after a newer
commit has arrived.

The automatic path therefore requires current `main` to equal the producer
commit, both when selecting the artifact and again immediately before the
existing SCP step. If a newer main commit arrives while this deployment is
queued, awaits a configured approval or downloads its artifact, the older deployment fails closed.
It does not claim to have deployed anything. The newer commit must complete its
own CI. A failure for this reason is an intentional superseded-deployment
outcome, not a failed Maven build. The final check is not an atomic lock on the
remote branch; existing concurrency settings and production environment
controls are unchanged.

## Manual deployment and production boundaries

`workflow_dispatch` retains its independent JDK setup and original command:

```sh
./mvnw clean package -DskipTests --batch-mode --no-transfer-progress
```

It does not search for or reuse an automatic artifact. The existing production
environment, permissions, deployment concurrency, SCP destination, secret
references, SSH restart and runtime health checks are preserved. No EC2
deployment, configuration change, secret access or manual workflow dispatch is
part of the local artifact-helper tests.

## Contract and evidence scope

This bounded CI cost change moves the automatic path's packaging ownership to
the successful CI. It updates the older deployment-build placement described
by the original deployment work while retaining its JAR, SCP, systemd and
production verification requirements. It does not complete customer repository
rollout or prove a live application's behavior.

Run the helper's controlled local tests with:

```sh
node --test scripts/ci-artifact.test.mjs
```

They exercise producer selection, rejection cases, actual local Git identity,
manifest/JAR integrity and both existing deployment filenames with synthetic,
non-executable JAR bytes and an in-memory API double. They perform no network
requests and are not Maven, GitHub artifact-service or EC2 acceptance evidence.
