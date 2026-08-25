FROM rust:bookworm AS build
WORKDIR /src
COPY daemon ./daemon
RUN cd daemon && cargo build --locked --release --bin devpiped --bin devpipe

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fd-find fish git ripgrep sudo zsh \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash devpipe \
    && mkdir -p /home/devpipe/work \
    && chown -R devpipe:devpipe /home/devpipe
COPY --from=build /src/daemon/target/release/devpiped /usr/local/bin/devpiped
COPY --from=build /src/daemon/target/release/devpipe /usr/local/bin/devpipe
USER devpipe
WORKDIR /home/devpipe/work
ENV DEVPIPE_ADDR=0.0.0.0:7788
ENV DEVPIPE_INSECURE=1
EXPOSE 7788
ENTRYPOINT ["/usr/local/bin/devpiped"]
