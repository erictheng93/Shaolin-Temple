FROM rust:1.95.0-bookworm AS build
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock server/rust-toolchain.toml ./server/
COPY shared ./shared
COPY server/src ./server/src
WORKDIR /build/server
RUN cargo build --locked --release

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /build/server/target/release/temple-server /temple-server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/temple-server"]
