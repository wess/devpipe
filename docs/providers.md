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

Runpod uses the REST Pod API and the same OCI image as the Docker backend. Push
that image to a registry Runpod can read, then configure the API process:

```sh
docker build -f deploy/docker/box.Dockerfile -t registry.example/devpipe-box:latest .
docker push registry.example/devpipe-box:latest

export DEVPIPE_MACHINE_PROVIDER=runpod
export DEVPIPE_RUNPOD_IMAGE=registry.example/devpipe-box:latest
export RUNPOD_API_KEY=... # or connect it in the first-run wizard
export DEVPIPE_RUNPOD_REGIONS=US-GA-1,EU-RO-1 # optional
```

Runpod Pods expose the daemon through Runpod's trusted HTTPS proxy. Network
volumes are location-bound and selected when a Pod is created, so the adapter
creates a new Pod against the existing volume when a sleeping box wakes and
terminates the Pod when compute is released. No per-box DNS or provider
firewall is claimed. The stock image guarantees the daemon and baseline shell
tools; publish a derived image when the Runpod catalogue should advertise more.
