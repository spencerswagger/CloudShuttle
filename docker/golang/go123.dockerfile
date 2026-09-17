FROM golang:1.23-alpine
RUN apk add --no-cache curl git openssh-client ca-certificates
