ARG NODE_VERSION=22.22.0
ARG RUST_VERSION=1.99.1
FROM node:${NODE_VERSION}-bookworm-slim AS node
FROM rust:${RUST_VERSION}-slim-bookworm
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools build-essential pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in amd64) target=x86_64-unknown-linux-musl ;; arm64) target=aarch64-unknown-linux-musl ;; *) exit 1 ;; esac \
    && rustup target add "$target" \
    && printf '%s' "$target" > /rust-target
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY collect-native.mjs /builder/collect-native.mjs
ENV CC=musl-gcc AR=ar CARGO_TARGET_DIR=/out/target SOURCE_DATE_EPOCH=315532800
ENV RUSTFLAGS="-C target-feature=+crt-static -C relocation-model=static -C link-arg=-static -C debuginfo=0 --remap-path-prefix=/src=/app-src -C link-arg=-Wl,--build-id=none"
WORKDIR /src
ENTRYPOINT ["node", "/builder/collect-native.mjs"]
