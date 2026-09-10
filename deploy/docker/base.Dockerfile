# What an environment is made of.
#
# The old default was `debian:trixie-slim`, which meant the first five minutes
# of every new environment went on `apt`, every time, on a machine that had
# already done it for the environment next door. An agent handed a bare Debian
# spends its first turns installing a toolchain instead of working.
#
# So this is deliberately not minimal. It is the set of things that, missing,
# would stop somebody in their first ten minutes: a compiler, three runtimes,
# git, and the coding agent itself. Roughly 2.5GB, pulled once per host.
#
#   docker build -f deploy/docker/base.Dockerfile -t devpipe-base .
#   devpipe serve --image devpipe-base
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      file \
      git \
      gnupg \
      jq \
      less \
      libssl-dev \
      locales \
      man-db \
      openssh-client \
      pkg-config \
      procps \
      python3 \
      python3-venv \
      ripgrep \
      rsync \
      tmux \
      unzip \
      vim \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# A terminal that cannot render UTF-8 makes every modern CLI look broken, and
# the failure looks like the tool's fault rather than the locale's.
RUN sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/bun/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --default-toolchain stable --profile minimal \
    && rustup component add rustfmt clippy \
    && chmod -R a+w $CARGO_HOME $RUSTUP_HOME

# Node from nodesource rather than Debian's, which ships a version old enough
# that half of npm refuses to install against it.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

ENV BUN_INSTALL=/usr/local/bun
RUN curl -fsSL https://bun.sh/install | bash

RUN npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force

# The workspace is a bind mount from the host, so its owner is whoever owns the
# directory over there — and git refuses to operate in a repository it thinks
# belongs to somebody else. That refusal is a security feature on a shared
# machine and pure obstruction here, where the tenant is the person who owns
# both sides of the mount.
RUN git config --system --add safe.directory /workspace \
    && git config --system --add safe.directory '*'

# Nothing in here can open a browser, so anything that tries is redirected to
# the person attached instead. See deploy/docker/devpipe-open.
COPY deploy/docker/devpipe-open /usr/local/bin/devpipe-open
RUN chmod +x /usr/local/bin/devpipe-open \
    && for name in xdg-open open www-browser x-www-browser sensible-browser gnome-open; do \
         ln -sf /usr/local/bin/devpipe-open "/usr/local/bin/$name"; \
       done
ENV BROWSER=/usr/local/bin/devpipe-open

# Read by the docker backend when a client asks for a shell without naming
# one. An image that does not set it gets /bin/sh, which is correct for a
# borrowed alpine and miserable here.
ENV DEVPIPE_SHELL=/bin/bash

WORKDIR /workspace
