ARG REGISTRY_IMAGE=registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373
ARG DIND_IMAGE=docker:27-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce
FROM ${REGISTRY_IMAGE} AS registry
FROM ${DIND_IMAGE}
LABEL fleet.db-build-test="true"
COPY --from=registry /bin/registry /bin/registry
COPY --from=registry /etc/docker/registry/config.yml /etc/docker/registry/config.yml
COPY --chmod=0755 registry-test-entrypoint.sh /usr/local/bin/registry-test-entrypoint.sh
ENTRYPOINT ["registry-test-entrypoint.sh"]
