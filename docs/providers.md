# Machine providers

Devpipe separates the product's machine lifecycle from the API used to realise
it. Routes select a provider and ask the machine service to create or release a
resource; concrete provider calls live under `src/providers/`.

## The contract

Every provider implements compute lifecycle operations:

- create a machine tagged with the durable operation id
- inspect one opaque provider id
- list resources managed by Devpipe
- recover a resource from its operation id
- release a machine while preserving its workspace when requested

Workspaces, network policy and DNS, usage metrics, GPU support, and managed
bootstrap are capabilities. Callers check them rather than relying on optional
methods to behave like DigitalOcean.

The release operation is intentionally provider-owned. DigitalOcean detaches a
block volume before destroying a droplet. Docker removes a container and leaves
its named volume. Runpod must terminate or replace a Pod according to the
storage attached at creation. A generic sequence of `stop`, `detach`, and
`destroy` would encode the wrong lifecycle for two of those three backends.

## Durable operations

`machine_operations` is written before a provider mutation starts. It records
the provider, action, step, opaque resource id, attempts, bounded error, and an
idempotency key. New machines carry the operation id as a provider tag or Docker
label. If the API exits after the provider accepts a create but before the box
row is updated, startup inventory finds the resource by that id instead of
creating a second one.

Provisioning remains asynchronous after the machine exists, but it is no longer
anonymous. Workspace attachment and address publication update the operation,
and unfinished provision/wake operations resume at startup. Destroy and sleep
only change the box row after the provider confirms release.

## DigitalOcean

DigitalOcean is the production backend. It provides public VMs, block volumes,
tag-scoped external firewalls, DNS, bandwidth metrics, snapshots, and the live
GPU catalogue. Select it by leaving `DEVPIPE_MACHINE_PROVIDER` unset or setting:

```sh
export DEVPIPE_MACHINE_PROVIDER=digitalocean
```

The setup wizard stores the account token as an encrypted credential and checks
the account, DNS zone, and SSH keys before first use.

## Local Docker

Docker is the development and adapter-contract backend:

```sh
docker build -f deploy/docker/box.Dockerfile -t devpipe-box:local .
export DEVPIPE_MACHINE_PROVIDER=docker
export DEVPIPE_DOCKER_IMAGE=devpipe-box:local  # this is the default
```

It creates a constrained container, binds the daemon to a random loopback port,
and uses labelled named volumes for workspaces. The owner terminal is relayed
through the control plane because the loopback endpoint is private to its host.

Limitations are deliberate and visible: Docker supplies no provider firewall,
DNS, usage billing, GPU catalogue, or multi-tenant isolation. The image contains
the terminal runtime and basic development tools; selectable cloud-init tools
are not installed by this backend yet.

## Runpod

Runpod is planned, not enabled in this release. Its adapter should use the same
compute contract but an OCI runtime payload and outbound control-plane tunnel.
Network volumes are location-bound and chosen at Pod creation, and public proxy
or TCP endpoints do not have the same lifecycle as per-box DigitalOcean DNS.
Those differences belong in the adapter and its capabilities, not in box routes.

The acceptance bar is the shared lifecycle suite: create, find by operation,
connect, preserve workspace, release, recover after interruption, and reconcile
provider resources in both directions.
