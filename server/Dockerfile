FROM rust:1.95.0-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src ./src
RUN cargo build --locked --release

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /build/target/release/temple-server /temple-server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/temple-server"]
