FROM golang:1.21-alpine
RUN apk add --no-cache curl git openssh-client ca-certificates
