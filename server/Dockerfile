# syntax=docker/dockerfile:1

FROM golang:1.23-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/replay-server ./cmd/replay-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/replay-server /replay-server
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/replay-server"]
