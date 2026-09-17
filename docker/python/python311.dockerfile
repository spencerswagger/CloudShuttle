FROM python:3.11-alpine
RUN apk add --no-cache curl git openssh-client ca-certificates
